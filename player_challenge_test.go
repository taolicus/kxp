package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A reservation belongs to the player, so a second connection with the same pid
// sees the same open code instead of minting a second one -- "one open code per
// identity", enforced by the server rather than by the client.
func TestChallengeSecondTabSharesReservation(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)

	st1, snap1 := connectPlayer(t, srv, "", "")
	t.Cleanup(st1.close)
	pid := snapshotString(t, snap1, "pid")
	first := mint(t, srv, snapshotString(t, snap1, "id"))

	st2, snap2 := connectPlayer(t, srv, "", pid)
	t.Cleanup(st2.close)
	if snap1["id"] == snap2["id"] {
		t.Fatalf("tabs shared a connection id: %v", snap1["id"])
	}
	if again := mint(t, srv, snapshotString(t, snap2, "id")); again != first {
		t.Fatalf("second tab minted a new token: %q then %q", first, again)
	}
}

// A claim from the creator's own player is a self-join, refused even though it
// arrives on a different connection: the guard is by pid, not by connection id.
func TestChallengeSecondTabSelfJoinRefused(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)

	st1, snap1 := connectPlayer(t, srv, "", "")
	t.Cleanup(st1.close)
	pid := snapshotString(t, snap1, "pid")
	tok := mint(t, srv, snapshotString(t, snap1, "id"))

	st2, snap2 := connectPlayer(t, srv, "", pid)
	t.Cleanup(st2.close)
	if code := joinStatus(t, srv, snapshotString(t, snap2, "id"), tok); code != http.StatusConflict {
		t.Fatalf("second tab self-join: %d, want 409", code)
	}
}

// The reservation outlives a connection, so a claim pairs with whichever of the
// creator's connections is live -- here the creator dropped its first stream and
// reconnected before the claim.
func TestChallengeClaimPairsWithPlayersLiveConnection(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	t.Cleanup(srv.Close)

	st1, snap1 := connectPlayer(t, srv, "", "")
	pid := snapshotString(t, snap1, "pid")
	tok := mint(t, srv, snapshotString(t, snap1, "id"))

	h.removeClient(h.client(snapshotString(t, snap1, "id")))
	st1.close()

	st2, _ := connectPlayer(t, srv, "", pid)
	t.Cleanup(st2.close)

	q, snapQ := connectPlayer(t, srv, "", "")
	t.Cleanup(q.close)
	if code := joinStatus(t, srv, snapshotString(t, snapQ, "id"), tok); code != http.StatusOK {
		t.Fatalf("/join with a live owner connection: %d, want 200", code)
	}
	st2.readEventTyp(t, "matched", 5*time.Second)
}
