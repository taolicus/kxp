package main

import "testing"

// drainEventTypes takes whatever frames are already queued for a client without
// blocking, so a test can assert on absence as well as presence. A
// presence-only assertion cannot catch a frame that should never have been sent,
// which is exactly the stale-teardown bug.
func drainEventTypes(t *testing.T, c *Client) []string {
	t.Helper()
	var types []string
	for {
		select {
		case b := <-c.send:
			typ, _ := parseChunk(t, b)
			types = append(types, typ)
		default:
			return types
		}
	}
}

// TestFinishMatchSkipsTeardownForRepairedSide locks the stale-teardown fix. An
// abandoned ready handshake re-queues both sides, and requeue -> tryMatch ->
// makeMatch can re-pair a survivor into a *new* match before the abandoned
// match's teardown runs. Telling that side to go idle drops the client out of a
// round it is already playing: the browser reads the frame as a stateIdle edge
// out of matched and returns to the lobby while the server still holds it in the
// match. The bug is order-dependent (the probe suite saw it roughly 1 run in 7),
// so this drives the state directly rather than waiting for the race.
func TestFinishMatchSkipsTeardownForRepairedSide(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	// `old` puts both sides in it; `next` then re-points a at a new match, which
	// is what a re-pair does in production. b is deliberately left in `old`.
	old := h.makeMatch("old", defaultSeriesTarget, side{client: a}, side{client: b})
	next := h.makeMatch("new", defaultSeriesTarget, side{client: a}, side{bot: true})
	h.active.Add(1) // balance the decrement inside finishMatch

	h.finishMatch(old, [2]side{{client: a}, {client: b}})

	if got := drainEventTypes(t, a); len(got) != 0 {
		t.Errorf("re-paired side received %v, want no frames: it is playing match %q", got, next.id)
	}
	if got := drainEventTypes(t, b); len(got) != 1 || got[0] != "state" {
		t.Errorf("side still in the torn-down match received %v, want exactly [state]", got)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if a.match != next {
		t.Errorf("teardown clobbered the re-paired side's match pointer: got %v, want the new match", a.match)
	}
	if b.match != nil {
		t.Errorf("teardown left the finished match pointer set: %v", b.match)
	}
}

// TestFinishMatchSendsTeardownToBoth is the regression guard for the guard
// above. On the normal path both sides are still in the match being torn down
// and must still be told to go idle — otherwise a too-eager condition would
// strand every finished client in a done match with no route back to the lobby.
func TestFinishMatchSendsTeardownToBoth(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("done", defaultSeriesTarget, side{client: a}, side{client: b})
	h.active.Add(1)

	h.finishMatch(m, [2]side{{client: a}, {client: b}})

	for _, tc := range []struct {
		name string
		c    *Client
	}{{"a", a}, {"b", b}} {
		if got := drainEventTypes(t, tc.c); len(got) != 1 || got[0] != "state" {
			t.Errorf("%s received %v, want exactly [state]", tc.name, got)
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if a.match != nil || b.match != nil {
		t.Errorf("teardown left match pointers set: a=%v b=%v", a.match, b.match)
	}
}

// TestFinishMatchSkipsTornDownSide checks the third state of the pointer: a side
// already removed (its match cleared to nil by a reap or an explicit leave) must
// not be handed a frame for a match it is no longer in. Sending is harmless on
// the wire but it is exactly the unconditional behaviour the fix removes.
func TestFinishMatchSkipsTornDownSide(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("gone", defaultSeriesTarget, side{client: a}, side{client: b})
	h.active.Add(1)
	// b has already been torn down: removeClient clears the pointer to nil.
	h.mu.Lock()
	b.match = nil
	h.mu.Unlock()

	h.finishMatch(m, [2]side{{client: a}, {client: b}})

	if got := drainEventTypes(t, a); len(got) != 1 || got[0] != "state" {
		t.Errorf("side still in the match received %v, want exactly [state]", got)
	}
	if got := drainEventTypes(t, b); len(got) != 0 {
		t.Errorf("already-torn-down side received %v, want no frames", got)
	}
}
