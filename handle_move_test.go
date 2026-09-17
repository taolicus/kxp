package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func registerMoveTestClient(h *Hub, id string) *Client {
	c := newClient()
	c.id = id
	h.mu.Lock()
	h.clients[id] = c
	h.mu.Unlock()
	return c
}

func newMoveMatch(c *Client, phase int32, shootAt time.Time) *match {
	m := &match{id: "mvt"}
	c.match = m
	m.phase.Store(phase)
	m.shootAt = shootAt
	return m
}

func postMove(h *Hub, id, move string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"id":%q,"move":%q}`, id, move)
	req := httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.handleMove(rr, req)
	return rr
}

func TestHandleMoveNoMatch(t *testing.T) {
	h := NewHub()
	registerMoveTestClient(h, "n1")
	rr := postMove(h, "n1", "rock")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "no active match") {
		t.Errorf("body = %s, want no active match", rr.Body.String())
	}
}

func TestHandleMoveRejectsDuringCountdown(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "n2")
	newMoveMatch(c, phaseCountdown, time.Now())

	rr := postMove(h, "n2", "rock")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "too early") {
		t.Errorf("body = %s, want too early", rr.Body.String())
	}
	select {
	case msg := <-c.moves:
		t.Errorf("move leaked into channel during countdown: %+v", msg)
	default:
	}
}

func TestHandleMoveRejectsWhenDone(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "n3")
	newMoveMatch(c, phaseDone, time.Now())

	rr := postMove(h, "n3", "paper")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "match over") {
		t.Errorf("body = %s, want match over", rr.Body.String())
	}
}

func TestHandleMoveRejectsAfterDeadline(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "n4")
	newMoveMatch(c, phaseShoot, time.Now().Add(-2*shootWindow))

	rr := postMove(h, "n4", "scissors")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "too late") {
		t.Errorf("body = %s, want too late", rr.Body.String())
	}
	select {
	case msg := <-c.moves:
		t.Errorf("move leaked into channel past deadline: %+v", msg)
	default:
	}
}

func TestHandleMoveAcceptedDuringShoot(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "n5")
	newMoveMatch(c, phaseShoot, time.Now())

	rr := postMove(h, "n5", "rock")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	select {
	case msg := <-c.moves:
		if msg.move != MoveRock {
			t.Errorf("move = %q, want rock", msg.move)
		}
		if msg.arrive.IsZero() {
			t.Errorf("arrive time not set")
		}
	default:
		t.Fatal("move not buffered during shoot phase")
	}
}

func TestHandleMoveConflictsWhenFull(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "n6")
	newMoveMatch(c, phaseShoot, time.Now())

	rr1 := postMove(h, "n6", "rock")
	if rr1.Code != http.StatusOK {
		t.Fatalf("first status = %d, want 200", rr1.Code)
	}

	rr2 := postMove(h, "n6", "paper")
	if rr2.Code != http.StatusConflict {
		t.Fatalf("second status = %d, want 409", rr2.Code)
	}
	if !strings.Contains(rr2.Body.String(), "move already submitted") {
		t.Errorf("body = %s, want move already submitted", rr2.Body.String())
	}

	select {
	case msg := <-c.moves:
		if msg.move != MoveRock {
			t.Errorf("channel holds %q, want rock", msg.move)
		}
	default:
		t.Fatal("expected first move still buffered")
	}
	select {
	case msg := <-c.moves:
		t.Errorf("unexpected extra move in channel: %+v", msg)
	default:
	}
}
