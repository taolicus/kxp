package main

import (
	"testing"
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

	s := h.snapshot(c)
	if s["phase"] != "shoot" {
		t.Errorf("phase = %v, want shoot", s["phase"])
	}
	if got := s["windowMs"]; got != shootWindow.Milliseconds() {
		t.Errorf("windowMs = %v, want %v", got, shootWindow.Milliseconds())
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
