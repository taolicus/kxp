package main

import (
	"testing"
	"time"
)

// A CPU round's outcome is otherwise decided by math/rand, which no test can
// pin. The injected picker and think time make the bot's move and its arrival
// deterministic: a zero think time completes botAction inline (the send is
// buffered), so nothing here races or sleeps.
func TestBotActionUsesTheInjectedPickerAndClock(t *testing.T) {
	m := newMatch(1)
	m.botMove = make(chan moveMsg, 1)
	at := time.Unix(1000, 0)
	m.now = func() time.Time { return at }
	m.pickMove = func() Move { return MoveScissors }
	m.botThink = func() time.Duration { return 0 }

	m.botAction()

	select {
	case got := <-m.botMove:
		if got.move != MoveScissors {
			t.Errorf("bot move = %q, want scissors from the injected picker", got.move)
		}
		if !got.arrive.Equal(at) {
			t.Errorf("bot arrival = %v, want the match clock %v", got.arrive, at)
		}
	default:
		t.Fatal("the bot did not move")
	}
}

// The shipped hooks must still be reached when a match never went through
// newMatch, so the fallback is pinned in both directions: a valid move and the
// 50–349ms jitter window.
func TestBotHooksFallBackWhenUnset(t *testing.T) {
	m := &match{}
	if got := m.botMovePick(); !ValidMove(got) {
		t.Errorf("fallback pick = %q, want a valid move", got)
	}
	if d := m.botThinkTime(); d < 50*time.Millisecond || d >= 350*time.Millisecond {
		t.Errorf("fallback think = %v, want within [50ms, 350ms)", d)
	}
}
