package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func getJSON(t *testing.T, h *Hub, path string) map[string]json.RawMessage {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", path, nil)
	h.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s status = %d, want 200 (%s)", path, rec.Code, rec.Body.String())
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s: bad json: %v", path, err)
	}
	return out
}

func TestHealthShape(t *testing.T) {
	h := NewHub()
	out := getJSON(t, h, "/health")

	var status string
	if err := json.Unmarshal(out["status"], &status); err != nil || status != "ok" {
		t.Errorf("status = %q, want ok", status)
	}
	for _, key := range []string{"uptime", "online", "queue", "activeMatches"} {
		if _, ok := out[key]; !ok {
			t.Errorf("health missing key %q", key)
		}
	}
}

func TestMetricsCountersMove(t *testing.T) {
	h := NewHub()

	rec := httptest.NewRecorder()
	h.handlerError(rec, http.StatusConflict, "move already submitted")

	c, ok := h.getOrCreate("")
	if !ok {
		t.Fatal("getOrCreate failed")
	}
	h.removeClient(c)

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	accessLog(h.metrics, next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/cpu", nil))

	var counts struct {
		Requests int            `json:"requests"`
		Rejects  int            `json:"rejects"`
		Joined   int            `json:"joined"`
		Left     int            `json:"left"`
		ByCode   map[string]int `json:"byCode"`
		ByMsg    map[string]int `json:"byMsg"`
	}
	raw, _ := json.Marshal(getJSON(t, h, "/metrics")["counts"])
	if err := json.Unmarshal(raw, &counts); err != nil {
		t.Fatalf("counts malformed: %v", err)
	}
	if counts.Requests != 1 {
		t.Errorf("requests = %d, want 1", counts.Requests)
	}
	if counts.Rejects != 1 {
		t.Errorf("rejects = %d, want 1", counts.Rejects)
	}
	if counts.Joined != 1 || counts.Left != 1 {
		t.Errorf("joined/left = %d/%d, want 1/1", counts.Joined, counts.Left)
	}
	if counts.ByCode["409"] != 1 {
		t.Errorf("byCode[409] = %d, want 1", counts.ByCode["409"])
	}
	if counts.ByMsg["move already submitted"] != 1 {
		t.Errorf("byMsg['move already submitted'] = %d, want 1", counts.ByMsg["move already submitted"])
	}
}

func TestMetricsRateLimitedIncrements(t *testing.T) {
	h := NewHub()
	h.limiter.mu.Lock()
	h.limiter.byIP["10.0.0.1"] = rateLimitEntry{tokens: 0, last: h.limiter.now()}
	h.limiter.mu.Unlock()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/queue", nil)
	req.RemoteAddr = "10.0.0.1:9999"
	h.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}

	var counts struct {
		RateLimited int `json:"rateLimited"`
	}
	raw, _ := json.Marshal(getJSON(t, h, "/metrics")["counts"])
	if err := json.Unmarshal(raw, &counts); err != nil {
		t.Fatalf("counts malformed: %v", err)
	}
	if counts.RateLimited != 1 {
		t.Errorf("rateLimited = %d, want 1", counts.RateLimited)
	}

	// The 429 also lands in the request breakdown? It does not pass through
	// accessLog in this test (routes are wired without it), so only the
	// rateLimited counter is asserted above.
}

func TestMetricsUptimeMonotonic(t *testing.T) {
	h := NewHub()
	out := getJSON(t, h, "/metrics")
	var up float64
	if err := json.Unmarshal(out["uptime"], &up); err != nil {
		t.Fatalf("uptime malformed: %v", err)
	}
	if up <= 0 {
		t.Errorf("uptime = %v, want > 0", up)
	}
}
