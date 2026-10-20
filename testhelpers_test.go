package main

import "time"

// newPartiedMatch builds an engine match wired to concrete clients, for tests
// that exercise resolve()/abort()/etc. without running a match or a hub.
func newPartiedMatch(a, b *Client) *match {
	m := newMatch(defaultSeriesTarget)
	m.sides[0] = matchParty{
		name:      "Opponent",
		character: a.character,
		emit:      a.sendEv,
		moves:     a.moves,
		left:      a.alive.Done(),
	}
	m.sides[1] = matchParty{
		name:      "Opponent",
		character: b.character,
		emit:      b.sendEv,
		moves:     b.moves,
		left:      b.alive.Done(),
	}
	return m
}

// noPacing builds a hub whose matches skip the between-rounds pause. The pause
// exists so a client can read the round it just finished; a test that plays a
// whole series does not need the wall-clock wait, and it must be removed at
// construction rather than afterwards -- the match goroutine reads the pacing as
// it runs, so writing it later is the race CI's first -race run found, just moved
// from the package var to a field.
func noPacing() *Hub {
	h := NewHub()
	h.tuneMatch = func(m *match) { m.seriesBreak = time.Nanosecond }
	return h
}

// shortGateTimeout shrinks the opening-handshake timeout on the hub itself, for a
// test whose match re-queues: the re-pairing goes through tryMatch, which builds
// a match from the hub's pacing, so shortening only the first match would leave
// the second one waiting out the shipped eight seconds. Call it before the first
// match is built.
func shortGateTimeout(h *Hub, d time.Duration) {
	h.pacing.readyTimeout = d
}
