package main

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// connectPlayer opens an /events stream with an optional connection id and an
// optional persistent player id, returning the live stream and the first
// `connected` snapshot so a test can read the ids the server handed back.
func connectPlayer(t *testing.T, srv *httptest.Server, id, pid string) (*sseStream, map[string]any) {
	t.Helper()
	endpoint := srv.URL + "/events"
	q := url.Values{}
	if id != "" {
		q.Set("id", id)
	}
	if pid != "" {
		q.Set("pid", pid)
	}
	if len(q) > 0 {
		endpoint += "?" + q.Encode()
	}
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	resp, err := testClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	st := &sseStream{resp: resp, br: bufio.NewReader(resp.Body), cancel: cancel}
	for {
		typ, data := st.readEvent(t, 5*time.Second)
		if typ != "connected" {
			continue
		}
		return st, data
	}
}

func snapshotString(t *testing.T, snap map[string]any, key string) string {
	t.Helper()
	v, _ := snap[key].(string)
	if v == "" {
		t.Fatalf("connected snapshot carried no %q: %v", key, snap)
	}
	return v
}

// TestEventsMintsPlayerID pins that every connection is handed a server-issued
// player id alongside its connection id.
func TestEventsMintsPlayerID(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, snap := connectPlayer(t, srv, "", "")
	defer st.close()

	snapshotString(t, snap, "id")
	snapshotString(t, snap, "pid")
}

// TestEventsReattachesKnownPlayerID is the persistence direction: a second
// connection presenting the pid lands on the same player while keeping its own
// connection id, which is what a reload or a second tab does.
func TestEventsReattachesKnownPlayerID(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st1, snap1 := connectPlayer(t, srv, "", "")
	defer st1.close()
	pid := snapshotString(t, snap1, "pid")

	st2, snap2 := connectPlayer(t, srv, "", pid)
	defer st2.close()

	if got := snapshotString(t, snap2, "pid"); got != pid {
		t.Fatalf("reattached pid = %q, want %q", got, pid)
	}
	if snap1["id"] == snap2["id"] {
		t.Fatalf("two connections shared the connection id %v", snap1["id"])
	}
}

// TestEventsMintsFreshForUnknownPlayerID is the server-issued direction: a pid
// the server never handed out is not adopted, or a client could choose its own
// identity. The connection gets a fresh one instead.
func TestEventsMintsFreshForUnknownPlayerID(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, snap := connectPlayer(t, srv, "", "not-a-server-issued-pid")
	defer st.close()

	if got := snapshotString(t, snap, "pid"); got == "not-a-server-issued-pid" {
		t.Fatalf("unknown pid was adopted: %q", got)
	}
}

// TestEventsHonorsConnectionID is the no-change direction: without a pid the
// transport behaves exactly as before, and a presented connection id is still
// reused.
func TestEventsHonorsConnectionID(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, snap := connectPlayer(t, srv, "legacy-conn", "")
	defer st.close()

	if got := snapshotString(t, snap, "id"); got != "legacy-conn" {
		t.Fatalf("connection id = %q, want legacy-conn", got)
	}
}

// TestSnapshotCarriesPlayerID pins the field the client persists, directly on
// the snapshot rather than through a stream.
func TestSnapshotCarriesPlayerID(t *testing.T) {
	h := NewHub()
	c, ok := h.getOrCreate("", "")
	if !ok {
		t.Fatal("getOrCreate failed")
	}
	snap := h.snapshot(c)
	if got, _ := snap["pid"].(string); got == "" || got != c.pid {
		t.Fatalf("snapshot pid = %v, want %q", snap["pid"], c.pid)
	}
}

// TestPlayerRegistryBounded pins the memory bound on the registry, which
// accumulates identities rather than tracking concurrent connections. The
// oldest is evicted past the cap; a dropped browser just gets a fresh pid.
func TestPlayerRegistryBounded(t *testing.T) {
	h := NewHub()
	h.mu.Lock()
	for i := 0; i < maxPlayers+10; i++ {
		h.resolvePlayerLocked("")
	}
	n := len(h.players)
	h.mu.Unlock()
	if n > maxPlayers {
		t.Fatalf("players = %d, want <= %d", n, maxPlayers)
	}
}
