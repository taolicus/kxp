package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The queue pairs only equal lengths, and a side handed back to it after a
// failed handshake keeps the length it was playing. Both halves of
// game-mode-architecture's pairing rule; a first-to-three match whose sides
// re-entered as one-off entries would strand them in a queue they can never
// leave, because no equal-mode partner ever arrives for them.

func postQueue(t *testing.T, h *Hub, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/queue", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.handleQueue(rr, req)
	return rr
}

// tryMatchNow runs the pairing pass in this goroutine. handleQueue spawns one,
// which may already have run by the time this returns; the pass is idempotent
// under h.mu, so calling it directly turns "did the spawned pass see the queue
// yet" into a deterministic assertion about the queue itself.
func tryMatchNow(h *Hub) {
	h.tryMatch()
}

func TestQueuePairsOnlyEqualLengths(t *testing.T) {
	h := NewHub()
	w1 := registerMoveTestClient(h, "w1")
	w2 := registerMoveTestClient(h, "w2")
	w3 := registerMoveTestClient(h, "w3")
	t.Cleanup(w1.cancel)
	t.Cleanup(w2.cancel)
	t.Cleanup(w3.cancel)

	if rr := postQueue(t, h, `{"ID":"w1","roundsTarget":3}`); rr.Code != http.StatusOK {
		t.Fatalf("first-to-three queue status = %d, want 200", rr.Code)
	}
	if rr := postQueue(t, h, `{"ID":"w2"}`); rr.Code != http.StatusOK {
		t.Fatalf("one-round queue status = %d, want 200", rr.Code)
	}
	tryMatchNow(h)

	h.mu.Lock()
	lenAfterFirst := len(h.queue)
	w1Match, w2Match := w1.match, w2.match
	h.mu.Unlock()
	if lenAfterFirst != 2 || w1Match != nil || w2Match != nil {
		t.Fatalf("queue len = %d, matches = %v/%v: a first-to-three side was paired with a one-round side",
			lenAfterFirst, w1Match, w2Match)
	}

	// The equal length arrives: it pairs with the one already waiting for it,
	// and the one-round side stays in the queue untouched.
	if rr := postQueue(t, h, `{"ID":"w3","roundsTarget":3}`); rr.Code != http.StatusOK {
		t.Fatalf("second first-to-three queue status = %d, want 200", rr.Code)
	}
	tryMatchNow(h)

	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.queue) != 1 {
		t.Fatalf("queue len = %d, want 1 -- the one-round side is still waiting", len(h.queue))
	}
	if w2.match != nil {
		t.Error("the one-round side was paired")
	}
	if w1.match == nil || w3.match == nil || w1.match != w3.match {
		t.Fatalf("matches = %v/%v: the two first-to-three sides did not pair with each other",
			w1.match, w3.match)
	}
	// The length travels on the match, not just through the pairing: the
	// scoreboard is drawn from `matched`, which reads this field.
	if got := w1.match.roundsTarget; got != 3 {
		t.Errorf("paired match roundsTarget = %d, want 3", got)
	}
	// And the draw rule that goes with it: at a target above one, a draw
	// replays instead of deciding the match.
	if w1.match.drawEnds {
		t.Error("a first-to-three match ends on a draw, want a replaying draw")
	}
}

func TestRequeuedSideReentersWithTheLengthItWasPlaying(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	three := registerMoveTestClient(h, "rq-three")
	t.Cleanup(three.cancel)
	t.Cleanup(a.cancel)

	// A first-to-three match loses a side to a disconnect mid-handshake. The
	// survivor goes back to the queue asking for the length it was playing.
	m := h.makeMatch("rq3", defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()
	waitForEvent(t, a, "matched")
	m.ackReady(0)
	b.cancel()
	waitForEvent(t, a, "state")

	h.mu.Lock()
	stillQueued := a.queueing
	h.mu.Unlock()
	if !stillQueued {
		t.Fatal("survivor not re-queued after pending abandonment")
	}

	// A one-round joiner must not take that survivor's seat: pairing it would
	// strand both in a first-to-three nobody asked for, or a first-to-one
	// nobody is waiting for.
	if rr := postQueue(t, h, `{"ID":"rq-three"}`); rr.Code != http.StatusOK {
		t.Fatalf("one-round queue status = %d, want 200", rr.Code)
	}
	tryMatchNow(h)

	h.mu.Lock()
	lenNow := len(h.queue)
	aMatch := a.match
	threeMatch := three.match
	h.mu.Unlock()
	if aMatch != nil || threeMatch != nil || lenNow != 2 {
		t.Fatalf("matches = %v/%v, queue len = %d: a one-round side paired with a first-to-three survivor",
			aMatch, threeMatch, lenNow)
	}

	// Two first-to-three joiners: the survivor pairs with the first of them,
	// and the pairing carries the length the survivor was playing.
	x := registerMoveTestClient(h, "rq-x")
	y := registerMoveTestClient(h, "rq-y")
	t.Cleanup(x.cancel)
	t.Cleanup(y.cancel)
	if rr := postQueue(t, h, `{"ID":"rq-x","roundsTarget":3}`); rr.Code != http.StatusOK {
		t.Fatalf("first-to-three joiner status = %d, want 200", rr.Code)
	}
	if rr := postQueue(t, h, `{"ID":"rq-y","roundsTarget":3}`); rr.Code != http.StatusOK {
		t.Fatalf("first-to-three joiner status = %d, want 200", rr.Code)
	}
	tryMatchNow(h)

	h.mu.Lock()
	defer h.mu.Unlock()
	if a.match == nil || a.match.roundsTarget != defaultSeriesTarget {
		t.Fatalf("survivor match = %v: the survivor did not re-enter at the length it was playing", a.match)
	}
	if three.match != nil {
		t.Error("the one-round side was paired while an equal-length partner was available")
	}
}

// Re-posting while waiting is not an error and not a second seat: the entry's
// mode follows the last thing the client asked for, so a player who changes
// their mind in the lobby changes what they will be paired with.
func TestRequeueWhileWaitingUpdatesTheLength(t *testing.T) {
	h := NewHub()
	one := registerMoveTestClient(h, "up-one")
	x := registerMoveTestClient(h, "up-x")
	t.Cleanup(one.cancel)
	t.Cleanup(x.cancel)

	if rr := postQueue(t, h, `{"ID":"up-one"}`); rr.Code != http.StatusOK {
		t.Fatalf("one-round queue status = %d, want 200", rr.Code)
	}
	if rr := postQueue(t, h, `{"ID":"up-x","roundsTarget":3}`); rr.Code != http.StatusOK {
		t.Fatalf("first-to-three queue status = %d, want 200", rr.Code)
	}
	tryMatchNow(h)
	h.mu.Lock()
	pairedEarly := one.match != nil || x.match != nil
	h.mu.Unlock()
	if pairedEarly {
		t.Fatal("a one-round entry paired with a first-to-three entry")
	}

	// The waiting client asks for the other length before a partner arrives.
	if rr := postQueue(t, h, `{"ID":"up-one","roundsTarget":3}`); rr.Code != http.StatusOK {
		t.Fatalf("re-queue status = %d, want 200", rr.Code)
	}
	tryMatchNow(h)

	h.mu.Lock()
	defer h.mu.Unlock()
	if one.match == nil || x.match == nil || one.match != x.match {
		t.Fatalf("matches = %v/%v: the updated entry did not pair with its equal-length partner",
			one.match, x.match)
	}
	if len(h.queue) != 0 {
		t.Errorf("queue len = %d, want 0", len(h.queue))
	}
}
