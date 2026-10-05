package main

import (
	"testing"
	"time"
)

func TestPvPReadyGate(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("rg", defaultSeriesTarget, side{client: a}, side{client: b})
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
	t.Cleanup(a.cancel) // a CPU match is a series: it would play rounds for the rest of the run
	m := h.makeMatch("cpu0", defaultSeriesTarget, side{client: a}, side{bot: true})
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
	t.Cleanup(a.cancel) // a CPU match is a series: it would play rounds for the rest of the run
	m := h.makeMatch("cpu1", defaultSeriesTarget, side{client: a}, side{bot: true})
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

// TestCPUReadyTimeoutReturnsHumanToLobby covers the failure mode a CPU match can
// now hit: the human never acks, so the match is cancelled. The human goes back
// to the *lobby*, not onto the online queue — they asked for a CPU round, and
// requeueing them put them into the PvP queue for a human opponent they never
// asked for. The teardown frame says why, so the bounce is explicable.
func TestCPUReadyTimeoutReturnsHumanToLobby(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a := newClient()
	m := h.makeMatch("cpu2", defaultSeriesTarget, side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	if d["reason"] != "handshake-timeout" {
		t.Errorf("reason = %v, want handshake-timeout", d["reason"])
	}
	if _, ok := d["requeued"]; ok {
		t.Errorf("CPU human was reported requeued (%v), but a CPU timeout returns them to the lobby", d["requeued"])
	}
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if queued {
		t.Error("CPU human was put on the online queue after an unacked handshake timed out: that silently switches them from a CPU round to waiting for a human")
	}
}

// TestReadyTimeoutRequeuesAndExplainsBothSides covers the PvP half: both sides
// go back on the queue, and each is told so. Without `requeued` the client drops
// to the lobby while the server holds it in the queue — invisible, with no
// Cancel, and re-matched within the gate window again.
func TestReadyTimeoutRequeuesAndExplainsBothSides(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("to2", defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")

	for _, c := range []*Client{a, b} {
		d := waitForEvent(t, c, "state")
		if d["state"] != "idle" {
			t.Errorf("state event = %v, want idle", d["state"])
		}
		if d["reason"] != "handshake-timeout" {
			t.Errorf("reason = %v, want handshake-timeout", d["reason"])
		}
		if d["requeued"] != true {
			t.Errorf("requeued = %v, want true: the side went back on the queue, so the client must show the queue view", d["requeued"])
		}
	}
	// No assertion on `queueing` here: both sides land on the queue together and
	// tryMatch pairs them straight back up, so the flag is transient by design.
	// The lonely-queued-side case is pinned deterministically by the abandon test
	// below, where only the survivor is re-queued.
	a.cancel()
	b.cancel()
}

// TestReadyAbandonExplainsToSurvivor: when one side leaves before the countdown,
// the survivor is re-queued and told why. Silence here is the same defect as the
// timeout case — the round vanished for no stated reason.
func TestReadyAbandonExplainsToSurvivor(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("ab2", defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)

	b.cancel() // side 1 leaves before the countdown

	d := waitForEvent(t, a, "state")
	if d["reason"] != "opponent-left" {
		t.Errorf("reason = %v, want opponent-left", d["reason"])
	}
	if d["requeued"] != true {
		t.Errorf("requeued = %v, want true", d["requeued"])
	}
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if !queued {
		t.Fatal("survivor not re-queued after pending abandonment")
	}
}

// TestFinishedMatchTeardownCarriesNoReason is the guard on the additive
// contract: a match that played to completion must emit a bare `state idle`.
// If it carried a stale reason, every player would be told their round was
// cancelled right after they finished it.
func TestFinishedMatchTeardownCarriesNoReason(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("fin1", defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
	m.abort() // ends the match without a cancellation reason

	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	if _, ok := d["reason"]; ok {
		t.Errorf("finished match carried a cancellation reason (%v), want none", d["reason"])
	}
	if _, ok := d["requeued"]; ok {
		t.Errorf("finished match was reported requeued (%v), want no flag", d["requeued"])
	}
}

func TestReadyAbandonOnLeaveRequeuesSurvivor(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("ab1", defaultSeriesTarget, side{client: a}, side{client: b})
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
	m := h.makeMatch("to1", defaultSeriesTarget, side{client: a}, side{client: b})
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
