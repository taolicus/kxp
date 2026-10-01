package main

import (
	"testing"
	"time"
)

type timingCase struct {
	name     string
	aOff     time.Duration
	bOff     time.Duration
	aOutcome string
	bOutcome string
	aNote    string
	bNote    string
	aMs      *int64
	bMs      *int64
}

func ms(v int64) *int64 { return &v }

func resolveTimed(t *testing.T, aOff, bOff time.Duration) (map[string]any, map[string]any) {
	t.Helper()
	a, b := newClient(), newClient()
	m := newPartiedMatch(a, b)
	a.match, b.match = m, m
	shootAt := time.Now()
	m.setShootAt(shootAt)
	m.moves[0] = &moveMsg{move: MoveRock, arrive: shootAt.Add(aOff)}
	m.moves[1] = &moveMsg{move: MoveScissors, arrive: shootAt.Add(bOff)}
	m.resolve()
	ra := waitForEvent(t, a, "result")
	rb := waitForEvent(t, b, "result")
	return ra, rb
}

func TestResolveTimingBoundaries(t *testing.T) {
	cases := []timingCase{
		{name: "exactly-at-pun", aOff: 0, bOff: 0, aOutcome: "win", bOutcome: "loss", aNote: "", bNote: "", aMs: ms(0), bMs: ms(0)},
		{name: "just-after-pun", aOff: time.Millisecond, bOff: time.Millisecond, aOutcome: "win", bOutcome: "loss", aNote: "", bNote: "", aMs: ms(1), bMs: ms(1)},
		{name: "just-before-pun", aOff: -time.Millisecond, bOff: 0, aOutcome: "loss", bOutcome: "win", aNote: "early", bNote: "", aMs: nil, bMs: ms(0)},
		{name: "at-deadline", aOff: shootWindow, bOff: shootWindow, aOutcome: "win", bOutcome: "loss", aNote: "", bNote: "", aMs: ms(shootWindow.Milliseconds()), bMs: ms(shootWindow.Milliseconds())},
		{name: "after-deadline", aOff: shootWindow + time.Millisecond, bOff: shootWindow, aOutcome: "loss", bOutcome: "win", aNote: "late", bNote: "", aMs: nil, bMs: ms(shootWindow.Milliseconds())},
		{name: "mid-window", aOff: 50 * time.Millisecond, bOff: 50 * time.Millisecond, aOutcome: "win", bOutcome: "loss", aNote: "", bNote: "", aMs: ms(50), bMs: ms(50)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ra, rb := resolveTimed(t, tc.aOff, tc.bOff)

			if got := ra["outcome"]; got != tc.aOutcome {
				t.Errorf("a outcome = %v, want %v", got, tc.aOutcome)
			}
			if got := ra["yourNote"]; got != tc.aNote {
				t.Errorf("a note = %v, want %q", got, tc.aNote)
			}
			if got := ra["youTimingMs"]; !equalIntPtr(got, tc.aMs) {
				t.Errorf("a timing = %v, want %v", got, tc.aMs)
			}
			if tc.aOff < 0 {
				if got := ra["opponentNote"]; got != "" {
					t.Errorf("a opponentNote = %v, want none", got)
				}
			}

			if got := rb["outcome"]; got != tc.bOutcome {
				t.Errorf("b outcome = %v, want %v", got, tc.bOutcome)
			}
			if got := rb["yourNote"]; got != tc.bNote {
				t.Errorf("b note = %v, want %q", got, tc.bNote)
			}
			if got := rb["youTimingMs"]; !equalIntPtr(got, tc.bMs) {
				t.Errorf("b timing = %v, want %v", got, tc.bMs)
			}
		})
	}
}

func equalIntPtr(got any, want *int64) bool {
	if want == nil {
		return got == nil
	}
	f, ok := got.(float64)
	return ok && int64(f) == *want
}

func TestResolveEarlyNeverTimesOut(t *testing.T) {
	ra, _ := resolveTimed(t, -time.Hour, time.Hour)
	if ra["yourNote"] != "early" {
		t.Errorf("a note = %v, want early", ra["yourNote"])
	}
	if ra["youTimingMs"] != nil {
		t.Errorf("a timing = %v, want nil for early pick", ra["youTimingMs"])
	}
}

// TestResolveLatePickCannotWinTheRound is the far end of the window. resolve
// used to judge only `arrive >= shootAt` and leave the far end to handleMove,
// whose late check reads the clock and then stamps `arrive` from a second read
// a few lines later -- so a pick submitted in the final sliver of the window
// could pass that check, be stamped past the deadline, and be counted by
// drainPending as an on-time tap. The round then resolved on it.
//
// Rock beats scissors, so this is the shape that matters: before the fix the
// late pick *won* the round, and it now loses. Checked to fail against the
// one-sided check. The matching "at-deadline" case above pins the boundary from
// the other side, so this cannot be satisfied by simply rejecting everything
// past the window.
func TestResolveLatePickCannotWinTheRound(t *testing.T) {
	ra, rb := resolveTimed(t, shootWindow+40*time.Millisecond, 500*time.Millisecond)

	if got := ra["outcome"]; got != "loss" {
		t.Errorf("a outcome = %v, want loss (a pick past the window cannot win)", got)
	}
	if got := ra["yourNote"]; got != "late" {
		t.Errorf("a note = %v, want late", got)
	}
	if ra["youTimingMs"] != nil {
		t.Errorf("a timing = %v, want nil for a disqualified pick", ra["youTimingMs"])
	}
	if got := rb["outcome"]; got != "win" {
		t.Errorf("b outcome = %v, want win", got)
	}
	if got := rb["opponentNote"]; got != "late" {
		t.Errorf("b sees a opponentNote = %v, want late", got)
	}
}

// TestResolveLateIsNotATimeout keeps `late` a separate note from `timeout`.
// Connectivity-safe scoring (planned) scores a no-move `timeout` as a
// no-contest rather than a loss, and keeps `early` out of that rule because an
// early pick is a deliberate act. A late pick is the same kind of act, so
// reporting it as `timeout` would quietly turn it into a draw-scored no-contest
// once that work lands. Passes against the old code too -- it pins the contract
// choice, not the original defect.
func TestResolveLateIsNotATimeout(t *testing.T) {
	a, b := newClient(), newClient()
	m := newPartiedMatch(a, b)
	a.match, b.match = m, m
	shootAt := time.Now()
	m.setShootAt(shootAt)
	m.moves[0] = &moveMsg{move: MoveRock, arrive: shootAt.Add(shootWindow + 10*time.Millisecond)}
	// b makes no pick at all, so the round has one valid move and one absent
	// side -- the case the planned void rule keys on.
	m.resolve()

	ra := waitForEvent(t, a, "result")
	rb := waitForEvent(t, b, "result")

	if got := ra["yourNote"]; got == "timeout" {
		t.Error("a late pick reported note=timeout, which connectivity-safe scoring would score as a no-contest")
	}
	if got := rb["yourNote"]; got != "timeout" {
		t.Errorf("a genuine no-pick note = %v, want timeout", got)
	}
}

func resolveTimedClient(t *testing.T, aArrive time.Duration, aReaction time.Duration) (map[string]any, map[string]any) {
	t.Helper()
	a, b := newClient(), newClient()
	m := newPartiedMatch(a, b)
	a.match, b.match = m, m
	shootAt := time.Now()
	m.setShootAt(shootAt)
	const sawPunAt = int64(1_000_000_000)
	m.moves[0] = &moveMsg{move: MoveRock, arrive: shootAt.Add(aArrive), sawPunAt: sawPunAt, clickedAt: sawPunAt + aReaction.Milliseconds()}
	m.moves[1] = &moveMsg{move: MoveScissors, arrive: shootAt.Add(time.Millisecond)}
	m.resolve()
	ra := waitForEvent(t, a, "result")
	rb := waitForEvent(t, b, "result")
	return ra, rb
}

func intField(v any) int64 {
	if f, ok := v.(float64); ok {
		return int64(f)
	}
	return -1
}

func TestClientReactionExcludesNetwork(t *testing.T) {
	ra, rb := resolveTimedClient(t, 300*time.Millisecond, 250*time.Millisecond)

	if got := intField(ra["youClientMs"]); got != 250 {
		t.Errorf("youClientMs = %v, want 250 (client clock reaction)", got)
	}
	if got := intField(ra["youTimingMs"]); got != 300 {
		t.Errorf("youTimingMs = %v, want 300 (server clock still authoritative)", got)
	}
	if got := ra["outcome"]; got != "win" {
		t.Errorf("a outcome = %v, want win (validity uses arrival time)", got)
	}
	if rb["youClientMs"] != nil {
		t.Errorf("b youClientMs = %v, want nil without client timestamps", rb["youClientMs"])
	}
}

func TestClientReactionSpoofedIgnored(t *testing.T) {
	clients := []struct {
		name      string
		sawPunAt  int64
		clickedAt int64
	}{
		{name: "click-before-pun", sawPunAt: 1_000_000_000, clickedAt: 999_999_999},
		{name: "zero-timestamps", sawPunAt: 0, clickedAt: 0},
		{name: "negative-click", sawPunAt: 1_000_000_000, clickedAt: -1},
	}
	for _, tc := range clients {
		t.Run(tc.name, func(t *testing.T) {
			a, b := newClient(), newClient()
			m := newPartiedMatch(a, b)
			a.match, b.match = m, m
			shootAt := time.Now()
			m.setShootAt(shootAt)
			m.moves[0] = &moveMsg{move: MoveRock, arrive: shootAt.Add(time.Millisecond), sawPunAt: tc.sawPunAt, clickedAt: tc.clickedAt}
			m.moves[1] = &moveMsg{move: MoveScissors, arrive: shootAt.Add(2 * time.Millisecond)}
			m.resolve()
			ra := waitForEvent(t, a, "result")
			if ra["youClientMs"] != nil {
				t.Errorf("youClientMs = %v, want nil for spoofed timestamps", ra["youClientMs"])
			}
			if got := ra["outcome"]; got != "win" {
				t.Errorf("a outcome = %v, want win", got)
			}
		})
	}
}
