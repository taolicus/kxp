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
	m.shootAt.Store(shootAt.UnixNano())
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
		{name: "after-deadline", aOff: shootWindow + time.Millisecond, bOff: shootWindow, aOutcome: "win", bOutcome: "loss", aNote: "", bNote: "", aMs: ms(shootWindow.Milliseconds() + 1), bMs: ms(shootWindow.Milliseconds())},
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

func resolveTimedClient(t *testing.T, aArrive time.Duration, aReaction time.Duration) (map[string]any, map[string]any) {
	t.Helper()
	a, b := newClient(), newClient()
	m := newPartiedMatch(a, b)
	a.match, b.match = m, m
	shootAt := time.Now()
	m.shootAt.Store(shootAt.UnixNano())
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
			m.shootAt.Store(shootAt.UnixNano())
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
