package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHandleMoveRejectsOversizedBody(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "t1")
	newMoveMatch(c, phaseShoot, time.Now())

	big := fmt.Sprintf(`{"id":"t1","move":"paper","pad":%q}`, strings.Repeat("x", maxBodyBytes+4096))
	req := httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.handleMove(rr, req)

	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "body too large") {
		t.Errorf("body = %s, want body too large", rr.Body.String())
	}
	select {
	case msg := <-c.moves:
		t.Errorf("oversized move buffered: %+v", msg)
	default:
	}
}

func TestHandleQueueAcceptsSmallBody(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "t2")

	body := `{"id":"t2"}`
	req := httptest.NewRequest(http.MethodPost, "/queue", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.handleQueue(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	h.mu.Lock()
	queuing := c.queueing
	h.mu.Unlock()
	if !queuing {
		t.Error("client not queued after accepted request")
	}
}
