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

// TestCPUWaitsForHumanReady locks the gate for CPU matches: the countdown must
// not begin until the human acks. The client acks from the end of its
// `matched` handler, so this is a self-timing buffer — a slow client waits as
// long as it needs, a fast one pays nothing — rather than a fixed sleep.
func TestCPUWaitsForHumanReady(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("cpu0", side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	select {
	case <-a.send:
		t.Fatal("CPU countdown started before the human acked readiness")
	case <-time.After(120 * time.Millisecond):
	}

	m.ackReady(0)
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
}

// TestCPUBotAckDoesNotReleaseGate guards the mask: the CPU side has no client to
// be told anything, so its bit must not be able to satisfy the gate on its own.
func TestCPUBotAckDoesNotReleaseGate(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("cpu1", side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	m.ackReady(1) // the bot
	if m.allHumanReady() {
		t.Fatal("a bot ack satisfied the human readiness gate")
	}
	select {
	case <-a.send:
		t.Fatal("countdown started on a bot ack alone")
	case <-time.After(120 * time.Millisecond):
	}

	m.ackReady(0)
	waitForEvent(t, a, "countdown")
}

// TestCPUReadyTimeoutRequeuesHuman covers the new failure mode a CPU match can
// now hit: the human never acks, so the match is cancelled and the human goes
// back to the queue rather than being dropped with no round played.
func TestCPUReadyTimeoutRequeuesHuman(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a := newClient()
	m := h.makeMatch("cpu2", side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if !queued {
		t.Error("human not re-queued after an unacked CPU handshake timed out")
	}
	a.cancel()
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
