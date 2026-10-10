package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// challengeFor posts /challenge with a body and returns the status and token.
func challengeFor(t *testing.T, srv *httptest.Server, body map[string]any) (int, string) {
	t.Helper()
	code, resp := postJSON(t, srv.URL+"/challenge", body)
	tok, _ := resp["token"].(string)
	return code, tok
}

// An invite-first reservation advertises the creator's length, so a claim pairs
// at it rather than the one-round default.
func TestChallengePairsAtCreatorLength(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	st1, id1 := connect(t, srv)
	_, id2 := connect(t, srv)

	code, tok := challengeFor(t, srv, map[string]any{"id": id1, "roundsTarget": 3, "drawEnds": false})
	if code != http.StatusOK || tok == "" {
		t.Fatalf("/challenge: %d token %q", code, tok)
	}
	if code, body := postJSON(t, srv.URL+"/join", map[string]any{"id": id2, "token": tok}); code != http.StatusOK {
		t.Fatalf("/join: %d (%+v)", code, body)
	}
	got := st1.readEventTyp(t, "matched", 5*time.Second)
	if got["roundsTarget"] != float64(3) {
		t.Fatalf("matched roundsTarget = %v, want 3", got["roundsTarget"])
	}
}

// The no-change direction: a reservation minted with no length is the old
// one-round, draw-ends match, whose `matched` frame carries no series target.
func TestChallengeAbsentLengthIsOneRoundOff(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	st1, id1 := connect(t, srv)
	_, id2 := connect(t, srv)

	code, tok := challengeFor(t, srv, map[string]any{"id": id1})
	if code != http.StatusOK || tok == "" {
		t.Fatalf("/challenge: %d token %q", code, tok)
	}
	if code, body := postJSON(t, srv.URL+"/join", map[string]any{"id": id2, "token": tok}); code != http.StatusOK {
		t.Fatalf("/join: %d (%+v)", code, body)
	}
	got := st1.readEventTyp(t, "matched", 5*time.Second)
	if v, ok := got["roundsTarget"]; ok {
		t.Fatalf("one-round matched carried roundsTarget: %v", v)
	}
}

// A length the queue could not offer is refused, and the refusal leaves no
// reservation behind.
func TestChallengeRejectsUnsupportedLength(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	_, id1 := connect(t, srv)

	code, _ := challengeFor(t, srv, map[string]any{"id": id1, "roundsTarget": 2})
	if code != http.StatusBadRequest {
		t.Fatalf("/challenge roundsTarget=2: %d, want 400", code)
	}
	h.mu.Lock()
	n := len(h.challenge)
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("invalid length left a reservation: %d", n)
	}
}

// Re-minting keeps the token but takes the player's current length -- the same
// "re-posting updates the seat" rule /queue uses.
func TestChallengeReMintUpdatesLength(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)
	st1, id1 := connect(t, srv)
	_, id2 := connect(t, srv)

	_, first := challengeFor(t, srv, map[string]any{"id": id1})
	code, again := challengeFor(t, srv, map[string]any{"id": id1, "roundsTarget": 3, "drawEnds": false})
	if code != http.StatusOK || again != first {
		t.Fatalf("re-mint: %d token %q, want the original %q", code, again, first)
	}
	if code, body := postJSON(t, srv.URL+"/join", map[string]any{"id": id2, "token": first}); code != http.StatusOK {
		t.Fatalf("/join: %d (%+v)", code, body)
	}
	got := st1.readEventTyp(t, "matched", 5*time.Second)
	if got["roundsTarget"] != float64(3) {
		t.Fatalf("matched roundsTarget = %v, want 3", got["roundsTarget"])
	}
}
