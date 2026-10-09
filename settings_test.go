package main

import (
	"flag"
	"testing"
	"time"
)

// operationalFlags must expose each value the engine and hub read, default to
// the shipped value, and parse into the same package var the code reads — one
// authoritative value, not a flag copy beside a constant. The parse is the pin:
// before this landed there was no route from a flag to these values at all.
func TestOperationalFlagsSetTheValuesTheGameReads(t *testing.T) {
	// Registration writes each default into its var, so snapshot and restore to
	// leave the package as the test found it.
	shoot, ready, sse := shootWindow, readyTimeout, sseWriteDeadline
	body, capacity, refill, maxEntries := maxBodyBytes, rlCapacity, rlRefillPerSec, rlMaxEntries
	t.Cleanup(func() {
		shootWindow, readyTimeout, sseWriteDeadline = shoot, ready, sse
		maxBodyBytes, rlCapacity, rlRefillPerSec, rlMaxEntries = body, capacity, refill, maxEntries
	})

	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	operationalFlags(fs)
	if err := fs.Parse([]string{
		"-shoot-window=3s",
		"-ready-timeout=9s",
		"-sse-write-deadline=6s",
		"-max-body-bytes=2048",
		"-rl-capacity=10",
		"-rl-refill-per-sec=1",
		"-rl-max-entries=8",
	}); err != nil {
		t.Fatalf("parse: %v", err)
	}

	cases := []struct {
		name string
		got  any
		want any
	}{
		{"shootWindow", shootWindow, 3 * time.Second},
		{"readyTimeout", readyTimeout, 9 * time.Second},
		{"sseWriteDeadline", sseWriteDeadline, 6 * time.Second},
		{"maxBodyBytes", maxBodyBytes, 2048},
		{"rlCapacity", rlCapacity, 10.0},
		{"rlRefillPerSec", rlRefillPerSec, 1.0},
		{"rlMaxEntries", rlMaxEntries, 8},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
}

// The other half of the chain: a retuned rate-limit var must reach the limiter
// NewHub builds. This is what makes the flag more than decoration — the hub
// reads the package var, not a compiled-in constant.
func TestNewHubReadsTheRateLimitVars(t *testing.T) {
	old := rlCapacity
	rlCapacity = 42
	t.Cleanup(func() { rlCapacity = old })

	if got := NewHub().limiter.capacity; got != 42 {
		t.Errorf("NewHub limiter capacity = %v, want 42 — the flag value did not reach the hub", got)
	}
}
