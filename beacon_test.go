package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postReport(t *testing.T, h *Hub, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/report", jsonBody(body))
	req.RemoteAddr = "10.1.2.3:4000"
	h.routes().ServeHTTP(rec, req)
	return rec
}

func TestBeaconLoggedAndCounted(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	h := NewHub()
	rec := postReport(t, h, map[string]any{
		"id":     "beaconed-client",
		"kind":   "sse-error",
		"state":  "shoot",
		"detail": "reconnect blip",
		"ts":     123,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	out := buf.String()
	if !strings.Contains(out, "kxp: beacon id=beaconed-client kind=sse-error state=shoot detail=\"reconnect blip\"") {
		t.Errorf("beacon log missing; got: %q", out)
	}

	var counts struct {
		Beacons      int            `json:"beacons"`
		ByBeaconKind map[string]int `json:"byBeaconKind"`
	}
	raw, _ := json.Marshal(getJSON(t, h, "/metrics")["counts"])
	if err := json.Unmarshal(raw, &counts); err != nil {
		t.Fatalf("counts malformed: %v", err)
	}
	if counts.Beacons != 1 || counts.ByBeaconKind["sse-error"] != 1 {
		t.Errorf("beacons = %d byKind=%v, want 1 byKind[sse-error]=1", counts.Beacons, counts.ByBeaconKind)
	}
}

func TestBeaconAcceptsUnknownID(t *testing.T) {
	// A beacon from a client the hub never saw (or already reaped) is still
	// accepted and logged: the "ghost" online-count hypothesis depends on
	// beacons from reaped clients actually arriving.
	h := NewHub()
	rec := postReport(t, h, map[string]any{
		"id":    "never-joined",
		"kind":  "fetch-error",
		"state": "lobby",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
}

func TestBeaconRejectsMissingKind(t *testing.T) {
	h := NewHub()
	rec := postReport(t, h, map[string]any{"id": "x", "state": "lobby"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestBeaconClipsOversizedFields(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	h := NewHub()
	rec := postReport(t, h, map[string]any{
		"id":     strings.Repeat("a", 100),
		"kind":   strings.Repeat("k", 100),
		"state":  strings.Repeat("s", 100),
		"detail": strings.Repeat("d", 320), // 320 > 256 clip cap, still < 1KB body limit
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	out := buf.String()
	if strings.Contains(out, strings.Repeat("a", 100)) || strings.Contains(out, strings.Repeat("k", 100)) {
		t.Errorf("oversized fields not clipped; got: %q", out)
	}
	if !strings.Contains(out, strings.Repeat("k", 48)) {
		t.Errorf("kind should be clipped to 48 chars; got: %q", out)
	}
}

func jsonBody(v any) *bytes.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}
