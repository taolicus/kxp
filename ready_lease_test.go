package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The lease is a duration measured against time.Now(), so testing it the obvious
// way means sleeping for the duration -- exactly the kind of wall-clock luck that
// passes on a quiet machine and fails on a hot one. Driving the match's injectable
// clock instead (fakeClock, shared with ratelimit_test.go) takes the sleep out of
// the sequence entirely.

func leaseClock() *fakeClock {
	c := newFakeClock(time.Now())
	return c
}

func advance(c *fakeClock, d time.Duration) {
	c.set(c.get().Add(d))
}

// twoSided is a PvP match with a fake clock already installed. Both sides are
// humans, so neither bit of the gate can be satisfied by a bot.
func twoSided(id string) (*Hub, *match, *Client, *Client, *fakeClock) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(id, defaultSeriesTarget, side{client: a}, side{client: b})
	clk := leaseClock()
	m.now = clk.get
	return h, m, a, b, clk
}

// TestStaleAckDoesNotOpenTheGate is the case the lease exists for. A side that
// acked once and then stopped is not ready when the countdown starts, but a
// one-shot bit says it is forever. Before the lease this match opened as soon as
// the second side arrived, however long after the first side's ack.
func TestStaleAckDoesNotOpenTheGate(t *testing.T) {
	oldTimeout := readyTimeout
	readyTimeout = 5 * time.Second
	defer func() { readyTimeout = oldTimeout }()

	_, m, a, b, clk := twoSided("stale")
	m.start()
	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")

	m.ackReady(0)
	advance(clk, readyLease+time.Second) // side 0's ack goes stale
	m.ackReady(1)                        // side 1 arrives on a link slower than the lease

	select {
	case <-a.send:
		t.Fatal("countdown started on a readiness ack that had already expired")
	case <-time.After(300 * time.Millisecond):
	}
}

// The negative direction: a stale side that is still there and still acking
// re-opens the gate on its next ack. Without this the lease would be a one-way
// door that fails closed and never recovers.
func TestRenewalReopensTheGate(t *testing.T) {
	oldTimeout := readyTimeout
	readyTimeout = 5 * time.Second
	defer func() { readyTimeout = oldTimeout }()

	_, m, a, _, clk := twoSided("renew-gate")
	m.start()
	waitForEvent(t, a, "matched")

	m.ackReady(0)
	m.ackReady(1)
	advance(clk, readyLease+time.Second) // both acks expire
	m.ackReady(0)                        // side 0 comes back
	m.ackReady(1)                        // and so does side 1

	waitForEvent(t, a, "countdown")
}

// A client that keeps acking must never expire its own lease. This is the bug an
// obvious implementation has: short-circuiting ackReady when the side has already
// acked once looks harmless and is not, because a repeat ack is the renewal that
// keeps the lease alive. An implementation that did that would stall every match
// for a client behaving perfectly.
func TestRepeatedAckRenewsTheLease(t *testing.T) {
	m := newMatch("renew-lease", defaultSeriesTarget)
	clk := leaseClock()
	m.now = clk.get

	m.ackReady(0)
	m.ackReady(1)
	if !m.allHumanReady() {
		t.Fatal("fresh acks did not satisfy the gate")
	}

	// Two renewals spaced inside the lease, with the clock passing the original
	// stamp in between: a renew-per-side-lease schedule must always read fresh.
	for i := 0; i < 3; i++ {
		advance(clk, readyLease/2)
		m.ackReady(0)
		m.ackReady(1)
		if !m.allHumanReady() {
			t.Fatalf("a client that keeps acking expired its own lease on renewal %d", i+1)
		}
	}
}

// And the other half of that property: a side that stops acking does expire. If
// this passed vacuously, everything above would be satisfied by a gate that never
// expires anything.
func TestStaleAckExpiresTheGate(t *testing.T) {
	m := newMatch("expire", defaultSeriesTarget)
	clk := leaseClock()
	m.now = clk.get

	m.ackReady(0)
	advance(clk, readyLease+time.Second)
	if m.allHumanReady() {
		t.Fatal("an ack past the lease still satisfied the gate")
	}
}

// A bot side must never contribute freshness, or a CPU match would open its gate
// on the strength of a side that has no client to receive anything.
func TestBotNeverSatisfiesTheGateLease(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("cpu-lease", defaultSeriesTarget, side{client: a}, side{bot: true})
	clk := leaseClock()
	m.now = clk.get

	m.ackReady(1) // the bot
	if m.allHumanReady() {
		t.Fatal("a bot ack satisfied the human readiness gate")
	}
	m.ackReady(0)
	if !m.allHumanReady() {
		t.Fatal("the human's own ack did not satisfy the gate")
	}
}

// The lease's real-world payoff: a side that vanishes for good does not get a
// round fired at it, it gets the handshake cancelled like any other absent side.
// This is the shape that matters, because the alternative is a countdown delivered
// to nobody and a player waiting out a round that can never be played.
func TestVanishedSideIsCancelledRatherThanServed(t *testing.T) {
	oldTimeout := readyTimeout
	readyTimeout = 800 * time.Millisecond
	defer func() { readyTimeout = oldTimeout }()

	_, m, a, b, clk := twoSided("vanish")
	m.start()
	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")

	m.ackReady(0)
	advance(clk, readyLease+time.Second) // side 0 goes away for good
	m.ackReady(1)                        // side 1 is present and asking

	// Scan rather than waitForEvent: the assertion is that no countdown arrives,
	// and a helper that skipped over unexpected event types could not see that.
	var seen []string
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case b := <-a.send:
			et, _ := parseChunk(t, b)
			seen = append(seen, et)
			if et == "countdown" || et == "shoot" {
				t.Fatalf("a vanished side was served %q; events so far: %v", et, seen)
			}
			if et == "state" {
				return // cancelled, which is the outcome under test
			}
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatalf("the handshake was never cancelled; events: %v", seen)
}

func postReady(h *Hub, id string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"id":%q}`, id)
	req := httptest.NewRequest(http.MethodPost, "/ready", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.handleReady(rr, req)
	return rr
}

// A client holding a match pointer whose side list does not contain it must not
// get a 200. Before the guard the handler fell through to 200 for an ack recorded
// against nobody, and a 200 is read as "the countdown is coming" -- so the client
// would sit waiting on a gate that nothing was holding open. I could not trace a
// reachable route to this state, which is why it is a guard rather than a fix for
// an observed failure; the assertion is that the lie is not available if one
// appears.
func TestReadyRejectsAClientThatIsNotASideOfItsMatch(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "outsider")

	m := &match{id: "other", readyCh: make(chan struct{}), now: time.Now}
	m.phase.Store(phaseCountdown)
	m.sides[0].moves = make(chan moveMsg, 1)
	m.sides[1].moves = make(chan moveMsg, 1)
	c.match = m

	rr := postReady(h, "outsider")
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for an ack that records against nobody", rr.Code)
	}
	if m.allHumanReady() {
		t.Fatal("an ack from a non-side opened the readiness gate")
	}
}

// The positive control for the guard above: a client that is genuinely a side
// still gets its 200 and still opens the gate. Without this the guard could be
// passing by rejecting everybody.
func TestReadyAcceptsAGenuineSide(t *testing.T) {
	h := NewHub()
	c := registerMoveTestClient(h, "insider")
	m := &match{id: "ok", readyCh: make(chan struct{}), now: time.Now}
	m.phase.Store(phaseCountdown)
	m.sides[0].moves = c.moves
	m.sides[1].moves = make(chan moveMsg, 1)
	c.match = m

	rr := postReady(h, "insider")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a real side", rr.Code)
	}
	if m.allHumanReady() {
		t.Fatal("the gate should still wait on the side that has not acked")
	}
	m.ackReady(1)
	if !m.allHumanReady() {
		t.Fatal("both sides acked and the gate did not open")
	}
}

// A match built as a struct literal rather than through newMatch has no injected
// clock, and several tests plus the reconnect path construct matches that way.
// Reading readiness from one used to nil-panic inside snapshot, which is on the
// reconnect path -- so the fallback is pinned here rather than left to whichever
// test happens to build a match literally.
func TestZeroValueMatchStillHasAClock(t *testing.T) {
	m := &match{id: "zero"}
	m.sides[0].moves = make(chan moveMsg, 1)
	m.sides[1].moves = make(chan moveMsg, 1)

	m.ackReady(0)
	m.ackReady(1)
	if !m.allHumanReady() {
		t.Fatal("a match with no injected clock could not read its own acks")
	}
}
