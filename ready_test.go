package main

import (
	"testing"
	"time"
)

func TestPvPReadyGate(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("rg", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")

	select {
	case <-a.send:
		t.Fatal("countdown started before any readiness ack")
	case <-time.After(120 * time.Millisecond):
	}

	m.ackReady(0)
	select {
	case <-a.send:
		t.Fatal("countdown started after only one readiness ack")
	case <-time.After(80 * time.Millisecond):
	}

	m.ackReady(1)
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
	waitForEvent(t, b, "shoot")
}

func TestCPUStartsWithoutReady(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("cpu0", side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
}

func TestReadyAbandonOnLeaveRequeuesSurvivor(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("ab1", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	m.ackReady(0)

	b.cancel() // side 1 leaves before the countdown

	waitForEvent(t, a, "state")
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if !queued {
		t.Fatal("survivor not re-queued after pending abandonment")
	}
}

func TestReadyTimeoutRequeuesBoth(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("to1", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	// Neither side acks: after readyTimeout both are re-queued and finishMatch
	// emits state idle (they may be instantly re-matched, which is fine).
	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	a.cancel()
	b.cancel()
}
