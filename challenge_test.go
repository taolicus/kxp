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

func (f *challengeFixture) queueLen() int {
	f.h.mu.Lock()
	defer f.h.mu.Unlock()
	return len(f.h.queue)
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
