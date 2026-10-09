package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// challengeFixture is a live challenge match: st1/id1 minted the link, st2/id2
// claimed it, and both have seen `matched`. st3/id3 is a third connected client
// used to probe the token after termination, and h is exposed so a test can
// assert the queue stayed empty.
type challengeFixture struct {
	h   *Hub
	srv *httptest.Server
	tok string

	st1, st2, st3 *sseStream
	id1, id2, id3 string
}

func setupChallenge(t *testing.T) *challengeFixture {
	t.Helper()
	f := &challengeFixture{h: NewHub()}
	f.srv = httptest.NewServer(f.h.routes())
	t.Cleanup(f.srv.Close)
	f.st1, f.id1 = connectSSE(t, f.srv, "")
	t.Cleanup(f.st1.close)
	f.st2, f.id2 = connectSSE(t, f.srv, "")
	t.Cleanup(f.st2.close)
	f.st3, f.id3 = connectSSE(t, f.srv, "")
	t.Cleanup(f.st3.close)

	code, body := postJSON(t, f.srv.URL+"/challenge", map[string]any{"id": f.id1})
	if code != http.StatusOK {
		t.Fatalf("/challenge status: %d", code)
	}
	f.tok, _ = body["token"].(string)
	if f.tok == "" {
		t.Fatalf("/challenge token missing: %+v", body)
	}
	if code, body := postJSON(t, f.srv.URL+"/join", map[string]any{"id": f.id2, "token": f.tok}); code != http.StatusOK {
		t.Fatalf("/join status: %d (body %+v)", code, body)
	}
	f.st1.readEventTyp(t, "matched", 5*time.Second)
	f.st2.readEventTyp(t, "matched", 5*time.Second)
	return f
}

// join returns the status of a /join for id against the fixture's token.
func (f *challengeFixture) join(t *testing.T, id string) int {
	code, _ := postJSON(t, f.srv.URL+"/join", map[string]any{"id": id, "token": f.tok})
	return code
}

func (f *challengeFixture) queueLen() int { return queueLen(f.h) }

// queueLen is the number of clients waiting in the global queue, read under h.mu.
func queueLen(h *Hub) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.queue)
}

// mint posts /challenge for id and returns the token, failing loudly if the mint
// itself did not succeed.
func mint(t *testing.T, srv *httptest.Server, id string) string {
	t.Helper()
	code, body := postJSON(t, srv.URL+"/challenge", map[string]any{"id": id})
	if code != http.StatusOK {
		t.Fatalf("/challenge: %d", code)
	}
	tok, _ := body["token"].(string)
	if tok == "" {
		t.Fatalf("/challenge token missing: %+v", body)
	}
	return tok
}

// joinStatus posts /join for id and returns only the status code.
func joinStatus(t *testing.T, srv *httptest.Server, id, tok string) int {
	t.Helper()
	code, _ := postJSON(t, srv.URL+"/join", map[string]any{"id": id, "token": tok})
	return code
}

// connect opens an SSE stream and registers its teardown, so the test's own
// httptest.Server.Close does not block on a handler that is still streaming.
func connect(t *testing.T, srv *httptest.Server) (*sseStream, string) {
	t.Helper()
	st, id := connectSSE(t, srv, "")
	t.Cleanup(st.close)
	return st, id
}

// The token outlives the pairing: while the match is live a second opener is
// told it is in play, not that the challenge is gone. Consuming at /join would
// make this a 404 and misreport a live link as dead.
func TestChallengeSecondOpenerRefusedWhileLive(t *testing.T) {
	f := setupChallenge(t)
	if code := f.join(t, f.id3); code != http.StatusConflict {
		t.Fatalf("second /join while live: %d, want 409", code)
	}
}

// A decided round ends the match, and the match's end is the link's end.
func TestChallengeConsumedAtDecidedEnd(t *testing.T) {
	f := setupChallenge(t)
	for _, id := range []string{f.id1, f.id2} {
		if code, _ := postJSON(t, f.srv.URL+"/ready", map[string]any{"id": id}); code != http.StatusOK {
			t.Fatalf("/ready %s: %d", id, code)
		}
	}
	readCountdown(t, f.st1, 5*time.Second)
	readCountdown(t, f.st2, 5*time.Second)
	postJSON(t, f.srv.URL+"/move", map[string]any{"id": f.id1, "move": "rock"})
	postJSON(t, f.srv.URL+"/move", map[string]any{"id": f.id2, "move": "scissors"})
	// The teardown frame is sent after finishMatch has dropped the token, so
	// reading it is the point after which the join must find nothing.
	for _, st := range []*sseStream{f.st1, f.st2} {
		st.readEventTyp(t, "result", 8*time.Second)
		st.readEventTyp(t, "state", 8*time.Second)
	}

	if code := f.join(t, f.id3); code != http.StatusNotFound {
		t.Fatalf("/join after a decided end: %d, want 404", code)
	}
	if n := f.queueLen(); n != 0 {
		t.Fatalf("challenge survivor queued: %d, want 0", n)
	}
}

// The opening handshake never acks: the match is cancelled, and that end
// consumes the link too.
func TestChallengeConsumedAtReadyTimeout(t *testing.T) {
	old := readyTimeout
	readyTimeout = 20 * time.Millisecond
	t.Cleanup(func() { readyTimeout = old })

	f := setupChallenge(t)
	f.st1.readEventTyp(t, "state", 5*time.Second)
	f.st2.readEventTyp(t, "state", 5*time.Second)

	if code := f.join(t, f.id3); code != http.StatusNotFound {
		t.Fatalf("/join after a ready timeout: %d, want 404", code)
	}
	if n := f.queueLen(); n != 0 {
		t.Fatalf("challenge survivor queued after timeout: %d, want 0", n)
	}
}

// A claimant who leaves before the countdown abandons the handshake; the
// survivor is not re-queued, and the link dies with the match.
func TestChallengeConsumedAtReadyAbandon(t *testing.T) {
	f := setupChallenge(t)
	f.st2.close()
	f.st1.readEventTyp(t, "state", 5*time.Second)

	if code := f.join(t, f.id3); code != http.StatusNotFound {
		t.Fatalf("/join after an abandon: %d, want 404", code)
	}
	if n := f.queueLen(); n != 0 {
		t.Fatalf("challenge survivor queued after abandon: %d, want 0", n)
	}
}

// Re-minting returns the open link rather than replacing it: a client that
// retries POST /challenge must not be able to kill the link it already shared.
func TestChallengeMintIsIdempotent(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id := connect(t, srv)

	first := mint(t, srv, id)
	if again := mint(t, srv, id); again != first {
		t.Fatalf("re-mint returned a new token: %q then %q", first, again)
	}
}

// A link and the global queue are mutually exclusive, in both directions:
// queueing behind a shared link must not kill it, and choosing to mint must
// leave the queue rather than hold both waits.
func TestChallengeAndQueueCannotBothBeOpen(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id := connect(t, srv)

	mint(t, srv, id)
	if code, body := postJSON(t, srv.URL+"/queue", map[string]any{"id": id}); code != http.StatusConflict {
		t.Fatalf("/queue with a link open: %d (body %+v), want 409", code, body)
	}

	_, id2 := connect(t, srv)
	if code, _ := postJSON(t, srv.URL+"/queue", map[string]any{"id": id2}); code != http.StatusOK {
		t.Fatalf("/queue: %d", code)
	}
	mint(t, srv, id2)
	if n := queueLen(h); n != 0 {
		t.Fatalf("creator still queued after minting: %d, want 0", n)
	}
}

// Cancel is the waiting view's own button, so it spends the link the creator
// was waiting on.
func TestChallengeCancelSpendsTheLink(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id1 := connect(t, srv)
	_, id2 := connect(t, srv)
	tok := mint(t, srv, id1)

	if code, _ := postJSON(t, srv.URL+"/cancel", map[string]any{"id": id1}); code != http.StatusOK {
		t.Fatalf("/cancel: %d", code)
	}
	if code := joinStatus(t, srv, id2, tok); code != http.StatusNotFound {
		t.Fatalf("/join after cancel: %d, want 404", code)
	}
}

// The waiting life of a link is bound to its creator: a disconnect drops it.
func TestChallengeDisconnectSpendsTheLink(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id1 := connect(t, srv)
	_, id2 := connect(t, srv)
	tok := mint(t, srv, id1)

	c := h.client(id1)
	if c == nil {
		t.Fatal("creator already gone")
	}
	h.removeClient(c)
	if code := joinStatus(t, srv, id2, tok); code != http.StatusNotFound {
		t.Fatalf("/join after the creator disconnected: %d, want 404", code)
	}
}

// The cap is a count of open links. Fill it directly rather than opening
// maxQueue live streams: the count is what the endpoint checks, and 128
// connections would test the socket more than the rule.
func TestChallengeCapRefusesPastTheLimit(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id := connect(t, srv)

	h.mu.Lock()
	for i := 0; i < maxQueue; i++ {
		tok := newID(8)
		h.challenges[tok] = &challengeEntry{token: tok}
	}
	h.mu.Unlock()

	if code, _ := postJSON(t, srv.URL+"/challenge", map[string]any{"id": id}); code != http.StatusServiceUnavailable {
		t.Fatalf("/challenge at the cap: %d, want 503", code)
	}
}

// A creator waiting on a link is waiting: the reconnect snapshot must say so and
// carry the token back, or a dropped radio walks the creator to the lobby and
// the link it shared disappears with it.
func TestChallengeWaitSurvivesReconnect(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id := connect(t, srv)
	tok := mint(t, srv, id)

	snap := h.snapshot(h.client(id))
	if snap["state"] != "waiting" {
		t.Fatalf("challenge waiter snapshot state: %v, want waiting", snap["state"])
	}
	if snap["challenge"] != tok {
		t.Fatalf("challenge waiter snapshot token: %v, want %q", snap["challenge"], tok)
	}
}

// The other half: a client in the global queue is also `waiting`, but it has no
// link, so the snapshot must not invent one.
func TestQueueSnapshotCarriesNoChallenge(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id := connect(t, srv)
	if code, _ := postJSON(t, srv.URL+"/queue", map[string]any{"id": id}); code != http.StatusOK {
		t.Fatalf("/queue: %d", code)
	}

	snap := h.snapshot(h.client(id))
	if snap["state"] != "waiting" {
		t.Fatalf("queued snapshot state: %v, want waiting", snap["state"])
	}
	if snap["challenge"] != nil {
		t.Fatalf("queued snapshot carried a challenge: %v", snap["challenge"])
	}
}
