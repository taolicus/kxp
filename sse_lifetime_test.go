package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// eventsWriter is a stand-in http.ResponseWriter for handleEvents that records
// what it was asked to write and supports ResponseController's write-deadline
// probe. It can be told to stall: once armed, every Write fails with a timeout
// error, emulating a stream whose peer vanished without a FIN (the dead device
// the bounded SSE lifetime exists to reap).
type eventsWriter struct {
	fail     atomic.Bool
	writes   atomic.Int32
	mu       sync.Mutex
	deadline []time.Time
	buf      strings.Builder
}

func (w *eventsWriter) Header() http.Header { return http.Header{} }
func (w *eventsWriter) WriteHeader(int)     {}

func (w *eventsWriter) SetWriteDeadline(t time.Time) error {
	w.mu.Lock()
	w.deadline = append(w.deadline, t)
	w.mu.Unlock()
	return nil
}

func (w *eventsWriter) Write(b []byte) (int, error) {
	w.writes.Add(1)
	if w.fail.Load() {
		return 0, netErrTimeout{}
	}
	w.mu.Lock()
	w.buf.Write(b)
	w.mu.Unlock()
	return len(b), nil
}

func (w *eventsWriter) Flush() {}

type netErrTimeout struct{}

func (netErrTimeout) Error() string   { return "i/o timeout" }
func (netErrTimeout) Timeout() bool   { return true }
func (netErrTimeout) Temporary() bool { return true }

// TestSSEWriteDeadlineArmsAndReapsStalledConn exercises the bounded SSE
// connection lifetime end to end: the handler arms a rolling per-write deadline,
// and a write that fails (peer gone, deadline fired) reaps the connection —
// the client is removed, the leave log records it, and the reaped counter moves.
func TestSSEWriteDeadlineArmsAndReapsStalledConn(t *testing.T) {
	prev := sseWriteDeadline
	sseWriteDeadline = 100 * time.Millisecond
	defer func() { sseWriteDeadline = prev }()

	bufLog, restore := captureLog(t)
	defer restore()

	h := NewHub()
	w := &eventsWriter{}
	req := httptest.NewRequest("GET", "/events?id=reapme", nil)

	done := make(chan struct{})
	go func() {
		h.handleEvents(w, req)
		close(done)
	}()

	// Let the connected frame flush, then break the stream and push a frame so
	// the loop is guaranteed to attempt a write after the stream goes dark.
	waitWrites(t, w, 1)
	w.fail.Store(true)
	h.mu.Lock()
	c := h.clients["reapme"]
	h.mu.Unlock()
	c.sendEvRaw(encodeEv(evt("state", map[string]any{"state": "idle"})))

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handleEvents did not return after the stalled write")
	}

	// The client that vanished mid-stream must be gone: online reconciles down.
	h.mu.Lock()
	if len(h.clients) != 0 {
		t.Errorf("clients online = %d, want 0 (reaped)", len(h.clients))
	}
	h.mu.Unlock()

	// A rolling deadline was armed before the failing write, not just cleared.
	w.mu.Lock()
	armed := false
	for _, d := range w.deadline {
		if !d.IsZero() {
			armed = true
			break
		}
	}
	w.mu.Unlock()
	if !armed {
		t.Error("no non-zero write deadline was ever armed")
	}

	if got := h.metrics.Copy().Reaped; got != 1 {
		t.Errorf("reaped = %d, want 1", got)
	}
	out := bufLog.String()
	if !strings.Contains(out, "reap client reapme") {
		t.Errorf("log missing reap line; got:\n%s", out)
	}
	if !strings.Contains(out, "leave online=0") {
		t.Errorf("log missing reconciled leave; got:\n%s", out)
	}
}

// TestSSEFrameJournalLoggedOnLeave proves the short per-client frame journal:
// frames actually flushed are recorded, and the leave line carries the last few
// so a reconnect/beacon can be correlated with what the client last saw.
func TestSSEFrameJournalLoggedOnLeave(t *testing.T) {
	bufLog, restore := captureLog(t)
	defer restore()

	h := NewHub()
	w := &eventsWriter{}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/events?id=journaled", nil).WithContext(ctx)

	h.getOrCreate("journaled")

	done := make(chan struct{})
	go func() {
		h.handleEvents(w, req)
		close(done)
	}()

	waitWrites(t, w, 1) // connected

	// Feed a few real frames the way the hub would, then hang up cleanly.
	h.mu.Lock()
	c := h.clients["journaled"]
	h.mu.Unlock()
	for _, b := range [][]byte{
		encodeEv(evt("waiting", map[string]any{"ts": 1})),
		encodeEv(evt("matched", map[string]any{"phase": "countdown"})),
		encodeEv(evt("result", map[string]any{"outcome": "win"})),
	} {
		c.sendEvRaw(b)
	}
	waitWrites(t, w, 4)

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handleEvents did not return after context cancel")
	}

	out := bufLog.String()
	if !strings.Contains(out, "frames=connected,online,waiting,matched,result") {
		t.Errorf("leave log missing frame journal; got:\n%s", out)
	}
	if strings.Contains(out, "reap client") {
		t.Errorf("clean cancel logged a reap; got:\n%s", out)
	}
}

// TestReapedCounterVisibleInMetrics checks the new counter is present in the
// /metrics payload after a reap, so operators can poll it.
func TestReapedCounterVisibleInMetrics(t *testing.T) {
	h := NewHub()
	c, _ := h.getOrCreate("mx")
	h.metrics.incReaped()
	h.removeClient(c)

	out := getJSON(t, h, "/metrics")
	var counts struct {
		Reaped int `json:"reaped"`
	}
	raw, _ := json.Marshal(out["counts"])
	if err := json.Unmarshal(raw, &counts); err != nil {
		t.Fatalf("counts malformed: %v", err)
	}
	if counts.Reaped != 1 {
		t.Errorf("metrics reaped = %d, want 1", counts.Reaped)
	}
}

func waitWrites(t *testing.T, w *eventsWriter, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for w.writes.Load() < int32(n) {
		if time.Now().After(deadline) {
			t.Fatalf("writes = %d, want %d by now", w.writes.Load(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
