package main

import (
	"net/http"
	"testing"
	"time"
)

func TestAdvanceRejectsWrongFrom(t *testing.T) {
	m := &match{}
	m.phase.Store(phaseCountdown)

	if m.advance(phaseIdle, phaseShoot) {
		t.Fatal("advance from idle succeeded while countdown")
	}
	if m.phase.Load() != phaseCountdown {
		t.Fatalf("phase = %v, want countdown after rejected advance", m.phase.Load())
	}
}

func TestAdvanceWinsOnlyOnce(t *testing.T) {
	m := &match{}
	m.phase.Store(phaseCountdown)

	if !m.advance(phaseCountdown, phaseShoot) {
		t.Fatalf("first advance failed")
	}
	if m.phase.Load() != phaseShoot {
		t.Fatalf("phase = %v, want shoot after first advance", m.phase.Load())
	}
	if m.advance(phaseCountdown, phaseShoot) {
		t.Fatal("second advance from same from-state succeeded")
	}
	if m.phase.Load() != phaseShoot {
		t.Fatalf("phase = %v, want unchanged shoot", m.phase.Load())
	}
}

func TestAllowedTransitionTable(t *testing.T) {
	cases := []struct {
		from int32
		to   int32
		want bool
	}{
		{phaseIdle, phasePreparing, true},
		{phasePreparing, phaseCountdown, true},
		{phasePreparing, phaseDone, true},
		{phaseCountdown, phaseShoot, true},
		{phaseCountdown, phaseDone, true},
		{phaseShoot, phaseDone, true},
		{phaseIdle, phaseCountdown, false},
		{phaseIdle, phaseShoot, false},
		{phaseIdle, phaseDone, false},
		{phaseCountdown, phaseIdle, false},
		{phaseShoot, phaseCountdown, false},
		{phasePreparing, phaseIdle, false},
		{phasePreparing, phaseShoot, false},
		{phaseDone, phaseShoot, false},
		// done -> countdown is the one edge out of done, and it exists only for the
		// series loop: judge walking a resolved-but-not-final round back to the
		// countdown. Nothing else may leave done, because every other path that
		// reaches it is a teardown -- a stale goroutine must not be able to restart
		// a round the match has already finished.
		{phaseDone, phaseCountdown, true},
		{phaseDone, phaseIdle, false},
		{phaseDone, phasePreparing, false},
	}
	for i, tc := range cases {
		m := &match{}
		m.phase.Store(tc.from)
		if got := m.advance(tc.from, tc.to); got != tc.want {
			t.Errorf("case %d: advance(%s, %s) = %v, want %v",
				i, phaseLabel(tc.from), phaseLabel(tc.to), got, tc.want)
		}
	}
}

func TestDoubleAbortEmitsOpponentLeftOnce(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("da1", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitForEvent(t, a, "shoot")
	waitForEvent(t, b, "shoot")

	a.cancel()
	m.abort()
	m.abort()

	d := waitForEvent(t, b, "opponent-left")
	if d["mode"] != "online" {
		t.Errorf("opponent-left mode = %v, want online", d["mode"])
	}
	select {
	case b2 := <-b.send:
		typ, _ := parseChunk(t, b2)
		if typ == "opponent-left" {
			t.Fatalf("second opponent-left emitted after double abort")
		}
	case <-time.After(50 * time.Millisecond):
	}
}

// The phase split's whole claim: a match waiting on readiness is in
// phasePreparing, and phaseCountdown -- the phase whose name promises a countdown
// -- does not begin until every human side has acked. Before the split this whole
// span was called phaseCountdown, so the phase named after the countdown covered
// the time before any countdown existed.
func TestCountdownPhaseBeginsOnlyWhenTheGateOpens(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("phase-split", side{client: a}, side{client: b})
	m.start()
	waitForEvent(t, a, "matched")

	if got := m.phase.Load(); got != phasePreparing {
		t.Fatalf("phase before any ack = %s, want preparing", phaseLabel(got))
	}
	m.ackReady(0)
	if got := m.phase.Load(); got != phasePreparing {
		t.Fatalf("phase after one of two acks = %s, want preparing", phaseLabel(got))
	}
	m.ackReady(1)
	// The countdown frame is only emitted after the gate closed the phase, so
	// receiving it is proof the transition happened.
	waitForEvent(t, a, "countdown")
	if got := m.phase.Load(); got == phasePreparing {
		t.Fatal("still preparing after every side acked")
	}
}

// handleReady must accept acks in phasePreparing, not only phaseCountdown. The
// gate is open *during* preparing -- the acks are what close it -- so a handler
// that still tested for phaseCountdown would answer 409 to every ack that
// mattered, and every match could then only ever end in a handshake timeout.
func TestReadyAckIsAcceptedDuringPreparing(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "prep")
	m := &match{id: "prep", readyCh: make(chan struct{}), now: time.Now}
	m.phase.Store(phasePreparing)
	m.sides[0].moves = c.moves
	m.sides[1].moves = make(chan moveMsg, 1)
	c.match = m

	if rr := postReady(h, "prep"); rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: acks are what close the preparing phase", rr.Code)
	}
	// Side 0's stamp specifically, not allHumanReady -- that needs both sides and
	// this test is about the one that acked.
	m.readyMu.Lock()
	stamped := !m.readyAt[0].IsZero()
	m.readyMu.Unlock()
	if !stamped {
		t.Fatal("the ack was answered 200 but never recorded")
	}
}
