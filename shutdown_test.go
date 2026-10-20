package main

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestHubShutdownEndsSSE(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	br := bufio.NewReader(resp.Body)
	if _, err := br.ReadString('\n'); err != nil {
		t.Fatalf("expected connected event, got error: %v", err)
	}

	h.Shutdown()

	done := make(chan struct{})
	go func() {
		for {
			if _, err := br.ReadString('\n'); err != nil {
				close(done)
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("SSE stream did not close after shutdown")
	}
}

func TestHubShutdownIdempotent(t *testing.T) {
	h := NewHub()
	h.Shutdown()
	h.Shutdown()
	select {
	case <-h.down.Done():
	default:
		t.Fatal("down context not closed after Shutdown")
	}
}

// TestHubShutdownJoinsRunningMatch pins the property CI's -race report was
// really about: a match goroutine must not still be running after Shutdown
// returns. The old Shutdown only cancelled h.down, which a match never observes
// -- the engine is client-agnostic and waits on its sides' leftCh -- so a match
// parked in its ready gate or its shoot window outlived the call and wrote into
// whatever ran next. That is how a leaked match from one test logged through the
// *next* test's captureLog sink and failed -race on
// TestSSEFrameJournalLoggedOnLeave
// (docs/tasks/open/test-helper-goroutine-leak.md).
//
// Both halves are asserted, and each is a separate negative.
//   - Waking: the match is demonstrably still parked in its gate when Shutdown is
//     called, and Shutdown must return well inside the 30s gate. Without the
//     client cancel this takes the full 30s (verified -- see the task file).
//   - Joining: the match records that its goroutine returned, and Shutdown must
//     not report completion before that record exists. Cancelling alone makes the
//     match exit quickly but not *before* Shutdown returns, so this half is what
//     catches a missing h.Wait() -- and it is ordered against the match's own
//     signal rather than a wall clock, because a timing test that passes for the
//     wrong reason is worse than none.
func TestHubShutdownJoinsRunningMatch(t *testing.T) {
	h := NewHub()
	// The gate timeout is deliberately long. A short one would let the match end
	// by timeout and make Shutdown look prompt for the wrong reason; the point is
	// that shutdown itself is what ends it.
	shortGateTimeout(h, 30*time.Second)
	stopHub(t, h)

	a, b := newClient(), newClient()
	// exited is closed by the match goroutine itself, from the same deferred
	// block that decrements the hub's counter, so it happens-before Shutdown's
	// Wait can return. Installed through tuneMatch rather than on the returned
	// match, because that runs inside makeMatch -- before the goroutine exists --
	// and writing a field the running match reads would itself be the kind of
	// race this test is about. Load/Store is enough: this is a one-way flag, and
	// -race still sees both accesses because the Wait provides the ordering.
	var exited atomic.Bool
	h.tuneMatch = func(m *match) { m.onExit = func() { exited.Store(true) } }

	// Both are registered and started, but neither acks, so the match is in
	// waitReady with 30 seconds still on its clock.
	startMatch(t, h, defaultSeriesTarget, side{client: a}, side{client: b})
	waitForEvent(t, a, "matched")

	// The match is demonstrably still parked in its gate: "matched" is sent
	// before waitReady, and "shoot" only after it, so a shoot frame would mean
	// the premise is gone.
	select {
	case ev := <-a.send:
		if frameType(ev) == "shoot" {
			t.Fatal("match left its gate without an ack; cannot test shutdown waking it")
		}
	case <-time.After(50 * time.Millisecond):
	}

	began := time.Now()
	h.Shutdown()
	if elapsed := time.Since(began); elapsed > 5*time.Second {
		t.Fatalf("Shutdown took %v with a 30s gate; it did not wake the match", elapsed)
	}
	if !exited.Load() {
		t.Fatal("Shutdown returned before the match goroutine exited; it did not join")
	}
}
