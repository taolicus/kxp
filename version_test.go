package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime/debug"
	"strings"
	"testing"
)

// The /health build field is the only thing that distinguishes "the probe suite
// tested the commit I just pushed" from "the probe suite tested whatever binary
// happens to be running". If it silently regressed to unknown, every live result
// would keep passing while measuring the wrong build — the probe suite would
// still be green, just meaningless.

func TestHealthReportsBuildIdentity(t *testing.T) {
	h := NewHub()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /health = %d, want 200", rec.Code)
	}
	var body struct {
		Build *buildID `json:"build"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("/health is not JSON: %v (body %q)", err, rec.Body.String())
	}
	if body.Build == nil {
		t.Fatalf("/health has no build field; the probe suite cannot tell which commit is live. body=%s", rec.Body.String())
	}
	if body.Build.SHA == "" {
		t.Error("/health build.sha is empty, want a commit or an explicit \"unknown\"")
	}
	if body.Build.Source == "" {
		t.Error("/health build.source is empty, want \"vcs\", \"ldflags\" or \"unknown\"")
	}
}

func TestIdentifyBuildFallsBackToUnknownOutsideVCS(t *testing.T) {
	// A binary built outside a git work tree carries no vcs.* settings, and the
	// override is empty in a test binary. It must say "unknown" rather than
	// reporting an empty or invented commit, so a deploy built that way is
	// visibly unverifiable instead of quietly unverifiable.
	got := identifyBuild()
	if got.SHA == "" {
		t.Error("identifyBuild().SHA is empty, want a non-empty value even when unverifiable")
	}
	if !isHexish(got.SHA) && got.SHA != "unknown" {
		t.Errorf("identifyBuild().SHA = %q, want a hex commit or \"unknown\"", got.SHA)
	}
}

// `go test` does not VCS-stamp test binaries, so identifyBuild() in a test always
// takes the unknown path and the stamped cases are unreachable through it. These
// drive the parser directly, which is the code that decides what production
// reports. The real-binary behaviour is checked by t1 against the deployed
// origin, which is the only place a stamped binary actually exists.
func TestParseBuildSettings(t *testing.T) {
	const sha = "516c03c9f0e1d2b3a4c5d6e7f8091a2b3c4d5e6f"
	cases := []struct {
		name     string
		settings []debug.BuildSetting
		want     buildID
	}{
		{
			name:     "no vcs settings (built outside a work tree)",
			settings: []debug.BuildSetting{{Key: "GOARCH", Value: "arm64"}},
			want:     buildID{SHA: "unknown", Source: "unknown"},
		},
		{
			name:     "clean stamp",
			settings: []debug.BuildSetting{{Key: "vcs.revision", Value: sha}, {Key: "vcs.modified", Value: "false"}},
			want:     buildID{SHA: sha, Source: "vcs"},
		},
		{
			name:     "dirty stamp is reported, not hidden",
			settings: []debug.BuildSetting{{Key: "vcs.revision", Value: sha}, {Key: "vcs.modified", Value: "true"}},
			want:     buildID{SHA: sha, Modified: true, Source: "vcs"},
		},
		{
			name:     "empty revision does not become a blank sha",
			settings: []debug.BuildSetting{{Key: "vcs.revision", Value: ""}},
			want:     buildID{SHA: "unknown", Source: "unknown"},
		},
		{
			name:     "modified without a revision stays unknown",
			settings: []debug.BuildSetting{{Key: "vcs.modified", Value: "true"}},
			want:     buildID{SHA: "unknown", Source: "unknown"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseBuildSettings(tc.settings); got != tc.want {
				t.Errorf("parseBuildSettings() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestBuildSHAOverrideWins(t *testing.T) {
	// The -ldflags escape hatch must be authoritative when set, including over
	// a VCS-stamped build, so a deliberate non-git build can still identify
	// itself and t1 can compare it.
	prev := buildSHA
	t.Cleanup(func() { buildSHA = prev })

	buildSHA = "deadbeef"
	got := identifyBuild()
	if got.SHA != "deadbeef" {
		t.Errorf("identifyBuild().SHA = %q, want the buildSHA override %q", got.SHA, "deadbeef")
	}
	if got.Source != "ldflags" {
		t.Errorf("identifyBuild().Source = %q, want %q", got.Source, "ldflags")
	}
}

// The stamped SHA is compared verbatim by t1 against a full local SHA, so any
// lossy formatting (truncation, prefixing) here would fail every deploy.
func TestParseBuildSettingsKeepsSHAVerbatim(t *testing.T) {
	const sha = "516c03c9f0e1d2b3a4c5d6e7f8091a2b3c4d5e6f"
	got := parseBuildSettings([]debug.BuildSetting{{Key: "vcs.revision", Value: sha}})
	if got.SHA != sha {
		t.Errorf("SHA = %q, want %q verbatim (no truncation or prefixing)", got.SHA, sha)
	}
	if len(got.SHA) != 40 {
		t.Errorf("SHA length = %d, want 40; t1 compares against git rev-parse HEAD", len(got.SHA))
	}
}

func isHexish(s string) bool {
	for _, r := range s {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return len(s) > 0
}
