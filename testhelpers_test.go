package main

import (
	"testing"
	"time"
)

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

// startMatch builds and starts a match on the hub under h.mu, returning it.
//
// It exists because makeMatch requires the lock and every test used to call it
// bare. That was harmless while makeMatch only wrote to the match it was
// building, and stopped being harmless once it began registering the match in
// h.running for Shutdown -- a map write a concurrently running match goroutine
// can read, which -race would report as a fresh race rather than the leak being
// fixed. Rather than teach forty tests about h.mu, they call this.
//
// It is the test-side twin of startMatchLocked, and it deliberately does not
// touch h.active: that counter is the hub's capacity gate, and a test that only
// wants a match running should not consume a production seat for it.
func startMatch(t *testing.T, h *Hub, roundsTarget int, a, b side) *match {
	t.Helper()
	h.mu.Lock()
	m := h.makeMatch(roundsTarget, a, b)
	// Registered the way startMatchLocked does, because Shutdown wakes a match by
	// cancelling the clients in h.running -- a match missing from it would be
	// joined by Wait but never woken, and Wait would then block for the full gate
	// timeout. That is not hypothetical: it is what a full-suite run showed as a
	// ten-minute hang before this line existed.
	h.running[m] = m.parties
	h.mu.Unlock()
	m.start()
	return m
}

// startBuiltMatch starts a match the caller already built with makeMatch, and
// registers it the way startMatch does. It is for the tests that must configure
// the match -- noSeriesBreak, shortReadyTimeout, an ack, a fake clock -- between
// building it and starting it, which is why startMatch's one-line form does not
// fit them.
func startBuiltMatch(t *testing.T, h *Hub, m *match) {
	t.Helper()
	h.mu.Lock()
	h.running[m] = m.parties
	h.mu.Unlock()
	m.start()
}

// shortGateTimeout shrinks the opening-handshake timeout on the hub itself, for a
// test whose match re-queues: the re-pairing goes through tryMatch, which builds
// a match from the hub's pacing, so shortening only the first match would leave
// the second one waiting out the shipped eight seconds. Call it before the first
// match is built.
func shortGateTimeout(h *Hub, d time.Duration) {
	h.pacing.readyTimeout = d
}

// stopHub cancels a hub and waits for the match goroutines it started to return,
// so none outlives the test that built it. Every test that starts a match needs
// this as its last act: a match goroutine left running writes through the hub's
// clients into whatever the *next* test is reading, which is the race CI's -race
// step reported between TestSSEFrameJournalLoggedOnLeave and a leaked match
// (docs/tasks/closed/test-helper-goroutine-leak.md).
//
// It cancels first, which is what makes the wait bounded rather than a full
// ready-timeout for every test: a match sitting in waitReady is abandoned by the
// same timeout the test already shrinks with shortGateTimeout or tuneMatch. A
// test that starts a match and does not call this is not failing today only
// because the leak is intermittent -- call it.
//
// Registered with t.Cleanup so it also covers a test that fails or fatals
// partway: t.Fatalf runs deferred functions but not code after it, and a leaked
// goroutine from a *failing* test is the worst case, because the failure is
// already being explained when the next test starts breaking.
func stopHub(t *testing.T, h *Hub) {
	t.Helper()
	t.Cleanup(func() {
		h.Shutdown()
	})
}
