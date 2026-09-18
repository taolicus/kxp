package main

import (
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
		{phaseIdle, phaseCountdown, true},
		{phaseCountdown, phaseShoot, true},
		{phaseCountdown, phaseDone, true},
		{phaseShoot, phaseDone, true},
		{phaseIdle, phaseShoot, false},
		{phaseIdle, phaseDone, false},
		{phaseCountdown, phaseIdle, false},
		{phaseShoot, phaseCountdown, false},
		{phaseDone, phaseIdle, false},
		{phaseDone, phaseShoot, false},
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
