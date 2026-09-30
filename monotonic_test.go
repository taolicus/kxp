package main

import (
	"strings"
	"testing"
	"time"
)

// TestShootAtKeepsMonotonicReading guards the representation the round's timing
// depends on.
//
// The announced deadline is compared against a time.Now() in three places inside
// a single round: arrival timing in resolve, the KA/CHI/PUN sleeps in run, and
// the too-late cutoff in handleMove. time.Time.Sub uses the monotonic reading
// only when *both* operands carry one, and falls back to wall-clock arithmetic
// otherwise — silently. A deadline stored as epoch-ns and rebuilt with time.Unix
// therefore has no monotonic reading, so all three comparisons degrade to the
// wall clock and come out wrong by exactly the size of any clock step in the
// interval. A phone that changes network or resyncs NTP does step mid-round.
//
// The failure is only observable under a real clock step, which cannot be
// injected, so this asserts the structural property instead: the stored deadline
// must retain its monotonic reading. time.Time.String renders that reading as a
// trailing " m=+<seconds>", which is how the two representations are told apart
// here. Verified to distinguish them before relying on it.
func TestShootAtKeepsMonotonicReading(t *testing.T) {
	m := newMatch("mono")
	if m.hasShootAt() {
		t.Fatal("a fresh match already reports an announced deadline")
	}

	m.setShootAt(time.Now().Add(2 * countStep))

	if !strings.Contains(m.shootAtTime().String(), " m=") {
		t.Errorf("announced deadline %v lost its monotonic reading; arrival timing, the countdown sleeps and the late cutoff would all fall back to wall-clock arithmetic", m.shootAtTime())
	}
	// The wall-only form of the same instant is exactly what must not be stored.
	wallOnly := time.Unix(0, m.shootAtMs()*int64(time.Millisecond))
	if strings.Contains(wallOnly.String(), " m=") {
		t.Fatal("test premise broken: the wall-only form unexpectedly has a monotonic reading")
	}
}

// TestShootAtWireValueIsUnchanged pins the protocol half of the change. The
// monotonic reading is an internal concern only; shootAt still has to go out as
// the same server epoch-ms a client reconciles against its own clock and skew
// estimate, or every client would re-anchor its PUN timer to the wrong instant.
func TestShootAtWireValueIsUnchanged(t *testing.T) {
	m := newMatch("wire")
	announceAt := time.Now()
	want := announceAt.Add(2 * countStep)

	m.setShootAt(want)

	if got, exp := m.shootAtMs(), want.UnixMilli(); got != exp {
		t.Errorf("shootAtMs = %d, want %d (the announced epoch-ms the client sees)", got, exp)
	}
	// And the deadline itself must still be the same instant, not merely the
	// same millisecond count.
	if !m.shootAtTime().Equal(want) {
		t.Errorf("shootAtTime = %v, want the announced instant %v", m.shootAtTime(), want)
	}
}

// TestArrivalTimingUsesElapsedNotWallClock checks the judgement end to end with
// the arrival stamped the way the server stamps it. It cannot reproduce a clock
// step, so it pins the ordinary case that the step corrupts: an on-time arrival
// must be judged against real elapsed time, and a move must never be reported as
// absurdly late. The failure seen on a moving device was exactly an on-time move
// reported ~13s late.
func TestArrivalTimingUsesElapsedNotWallClock(t *testing.T) {
	a, b := newClient(), newClient()
	m := newPartiedMatch(a, b)
	a.match, b.match = m, m

	announced := time.Now()
	m.setShootAt(announced)
	// An arrival 300ms after the announced deadline, as handleMove stamps it.
	onTime := time.Now().Add(300 * time.Millisecond)
	m.moves[0] = &moveMsg{move: MoveRock, arrive: onTime}
	m.moves[1] = &moveMsg{move: MoveScissors, arrive: onTime}
	m.resolve()

	ra := waitForEvent(t, a, "result")
	rb := waitForEvent(t, b, "result")
	for side, res := range map[string]map[string]any{"a": ra, "b": rb} {
		got, ok := res["youTimingMs"].(float64)
		if !ok {
			t.Fatalf("%s: youTimingMs = %v, want a reported timing for a move that arrived", side, res["youTimingMs"])
		}
		// Generous bounds: this is not a precision test, it is a "not absurd"
		// test. A wall-clock step of a few seconds would blow straight through.
		if got < 0 || got > 5000 {
			t.Errorf("%s: youTimingMs = %v, want a sane elapsed time for a 300ms-late arrival", side, got)
		}
	}
}
