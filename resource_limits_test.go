package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postRoutes(h *Hub, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.routes().ServeHTTP(rr, req)
	return rr
}

func fillClients(h *Hub, n int) {
	h.mu.Lock()
	for i := 0; i < n; i++ {
		c := newClient()
		c.id = fmt.Sprintf("fill-%d", i)
		h.clients[c.id] = c
	}
	h.mu.Unlock()
}

func registerTestClient(h *Hub, id string) *Client {
	c := newClient()
	c.id = id
	h.mu.Lock()
	h.clients[id] = c
	h.mu.Unlock()
	return c
}

func TestGetOrCreateRejectsPastCap(t *testing.T) {
	h := NewHub()
	fillClients(h, maxClients)

	if _, ok := h.getOrCreate("brandnew"); ok {
		t.Fatal("new client minted while at capacity")
	}

	existing := registerTestClient(h, "exists")
	got, ok := h.getOrCreate("exists")
	if !ok || got != existing {
		t.Fatal("existing client should always be returned at capacity")
	}
}

func TestEventsRejectsPastCap(t *testing.T) {
	h := NewHub()
	fillClients(h, maxClients)

	req := httptest.NewRequest(http.MethodGet, "/events?id=fresh", nil)
	rr := httptest.NewRecorder()
	h.routes().ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "too many clients") {
		t.Errorf("body = %s, want too many clients", rr.Body.String())
	}
}

func TestQueueRejectsPastCap(t *testing.T) {
	h := NewHub()
	registerTestClient(h, "b")
	h.mu.Lock()
	for i := 0; i < maxQueue; i++ {
		h.queue = append(h.queue, newClient())
	}
	h.mu.Unlock()

	rr := postRoutes(h, "/queue", `{"id":"b"}`)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "queue full") {
		t.Errorf("body = %s, want queue full", rr.Body.String())
	}
}

func TestMatchCapRejectsCPU(t *testing.T) {
	h := NewHub()
	registerTestClient(h, "c")
	h.active.Store(maxMatches)

	rr := postRoutes(h, "/cpu", `{"id":"c"}`)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "too many active matches") {
		t.Errorf("body = %s, want too many active matches", rr.Body.String())
	}
}

func TestMatchCapAllowsNormalFlow(t *testing.T) {
	h := NewHub()
	registerTestClient(h, "c")

	rr := postRoutes(h, "/cpu", `{"id":"c"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if got := h.active.Load(); got != 1 {
		t.Fatalf("active = %d, want 1 after one CPU match", got)
	}
}
