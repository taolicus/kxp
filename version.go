package main

import "runtime/debug"

// buildSHA overrides the reported build identity. It is normally empty: Go
// stamps VCS metadata into any binary built from a git work tree, so a plain
// `go build -o kxp .` identifies itself with no build script and no deploy-time
// discipline. Set it with -ldflags "-X main.buildSHA=..." for a build outside a
// work tree, or to label a deliberate non-git build.
var buildSHA string

// buildID is the identity of the running binary, as served on /health.
type buildID struct {
	// SHA is the commit the binary was built from, or "unknown".
	SHA string `json:"sha"`
	// Modified reports that the build tree had uncommitted changes, so the
	// binary is not byte-for-byte that commit.
	Modified bool `json:"modified"`
	// Source is how the identity was obtained: "vcs" (stamped by the Go
	// toolchain), "ldflags" (the buildSHA override), or "unknown".
	Source string `json:"source"`
}

// identifyBuild reports which commit this binary came from.
//
// The probe suite runs against a deployed origin, not a local build, so before
// this existed there was no way to tell from the outside whether the thing being
// tested was even the thing just written. Every live result was therefore
// conditional on an unverifiable assumption, which is the same failure shape as
// the probe origin defaulting to the wrong host: a green suite measuring the
// wrong build. t1 asserts this against the local HEAD.
func identifyBuild() buildID {
	if buildSHA != "" {
		return buildID{SHA: buildSHA, Source: "ldflags"}
	}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return unknownBuild()
	}
	return parseBuildSettings(bi.Settings)
}

func unknownBuild() buildID { return buildID{SHA: "unknown", Source: "unknown"} }

// parseBuildSettings pulls the identity out of the toolchain's build settings.
// Separated from identifyBuild because `go test` does not VCS-stamp test
// binaries, so a test that called identifyBuild directly could only ever assert
// the unknown path; the stamped cases have to be driven from synthetic settings
// to be covered at all.
func parseBuildSettings(settings []debug.BuildSetting) buildID {
	var sha string
	var modified bool
	for _, s := range settings {
		switch s.Key {
		case "vcs.revision":
			sha = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	// "Modified" is a claim about a specific commit, so it is only meaningful
	// alongside one. Reported without a SHA it would be a dirty flag attached to
	// nothing, and t1 would have to guess whether it mattered.
	if sha == "" {
		return unknownBuild()
	}
	return buildID{SHA: sha, Modified: modified, Source: "vcs"}
}
