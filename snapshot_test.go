package main

import (
	"testing"
	"time"
)

func TestPhaseNameDistinguishesDone(t *testing.T) {
	m := &match{}
	cases := map[int32]string{
		phaseIdle:      "idle",
		phaseCountdown: "countdown",
		phaseShoot:     "shoot",
		phaseDone:      "done",
	}
	for ph, want := range cases {
		m.phase.Store(ph)
		if got := m.phaseName(); got != want {
			t.Errorf("phase %d = %q, want %q", ph, got, want)
		}
	}
}

func TestSnapshotReportsDonePhase(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "sn1")
	m := &match{id: "sn1"}
	c.match = m
	m.phase.Store(phaseDone)

	s := h.snapshot(c)
	if s["state"] != "ingame" {
		t.Errorf("state = %v, want ingame", s["state"])
	}
	if s["phase"] != "done" {
		t.Errorf("phase = %v, want done", s["phase"])
	}
}

func TestSnapshotCarriesShootWindow(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "sn3")
	m := &match{id: "sn3"}
	c.match = m
	m.phase.Store(phaseShoot)
	m.shootAt.Store(time.Now().UnixNano())

	s := h.snapshot(c)
	if s["phase"] != "shoot" {
		t.Errorf("phase = %v, want shoot", s["phase"])
	}
	if s["shootAt"] != m.shootAtMs() {
		t.Errorf("shootAt = %v, want %d", s["shootAt"], m.shootAtMs())
	}
	if got := s["windowMs"]; got != shootWindow.Milliseconds() {
		t.Errorf("windowMs = %v, want %v", got, shootWindow.Milliseconds())
	}
}

func TestSnapshotCarriesCountdownPlan(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "snc1")
	m := &match{id: "snc1"}
	c.match = m
	m.phase.Store(phaseCountdown)
	m.shootAt.Store(time.Now().Add(2 * time.Second).UnixNano())

	s := h.snapshot(c)
	if s["phase"] != "countdown" {
		t.Fatalf("phase = %v, want countdown", s["phase"])
	}
	if got := s["windowMs"]; got != shootWindow.Milliseconds() {
		t.Errorf("windowMs = %v, want %v", got, shootWindow.Milliseconds())
	}
	if got := s["shootAt"]; got != m.shootAtMs() {
		t.Errorf("shootAt = %v, want %d", got, m.shootAtMs())
	}
}

// TestSnapshotOmitsPlanBeforeAnnounce locks v1.1 ordering: while the PvP
// handshake is still open (countdown phase, deadline not yet announced) the
// snapshot must not leak a plan the client could act on early.
func TestSnapshotOmitsPlanBeforeAnnounce(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "snc2")
	m := &match{id: "snc2"}
	c.match = m
	m.phase.Store(phaseCountdown)

	s := h.snapshot(c)
	if _, ok := s["shootAt"]; ok {
		t.Errorf("shootAt present before the round is announced: %v", s)
	}
	if _, ok := s["windowMs"]; ok {
		t.Errorf("windowMs present before the round is announced: %v", s)
	}
}

func TestSnapshotDistinguishesNoMatchFromDone(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "sn2")

	s := h.snapshot(c)
	if s["state"] != "idle" {
		t.Errorf("state = %v, want idle", s["state"])
	}
	if _, ok := s["phase"]; ok {
		t.Errorf("phase = %v, want absent without a match", s["phase"])
	}
}
