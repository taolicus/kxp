package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// testClient disables keep-alives so no idle pooled connection outlives a test
// and wedges httptest.Server.Close() waiting for it.
var testClient = &http.Client{
	Transport: &http.Transport{DisableKeepAlives: true},
}

// sseStream reads Server-Sent Events from a live connection, skipping keepalive
// comment frames (": ping"). Closing it cancels the request context so the
// server actually observes the disconnect.
type sseStream struct {
	resp   *http.Response
	br     *bufio.Reader
	cancel context.CancelFunc
}

func (s *sseStream) close() {
	if s.cancel != nil {
		s.cancel()
	}
	s.resp.Body.Close()
}

func (s *sseStream) readOne() (typ string, data map[string]any, err error) {
	typeLine, dataLine := "", ""
	for {
		line, e := s.br.ReadString('\n')
		if e != nil {
			return "", nil, e
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if typeLine == "" {
				continue
			}
			var m map[string]any
			if dataLine != "" {
				if e := json.Unmarshal([]byte(dataLine), &m); e != nil {
					return "", nil, e
				}
			}
			return typeLine, m, nil
		}
		if strings.HasPrefix(line, "event: ") {
			typeLine = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			dataLine += strings.TrimPrefix(line, "data: ")
		}
	}
}

func (s *sseStream) readEvent(t *testing.T, timeout time.Duration) (string, map[string]any) {
	t.Helper()
	type frame struct {
		typ  string
		data map[string]any
		err  error
	}
	deadline := time.Now().Add(timeout)
	for {
		ch := make(chan frame, 1)
		go func() {
			typ, data, err := s.readOne()
			ch <- frame{typ, data, err}
		}()
		select {
		case f := <-ch:
			if f.err != nil {
				t.Fatalf("reading SSE stream: %v", f.err)
			}
			if f.typ != "" {
				return f.typ, f.data
			}
		case <-time.After(time.Until(deadline)):
			s.close()
			t.Fatalf("SSE stream timed out after %v", timeout)
		}
	}
}

// readEventTyp reads the next frame, skipping the "online" presence, "waiting"
// queue, "state" status, and "countdown" frames that the server emits alongside
// the frame the test is waiting for.
func (s *sseStream) readEventTyp(t *testing.T, typ string, timeout time.Duration) map[string]any {
	t.Helper()
	for {
		got, data := s.readEvent(t, timeout)
		if got == typ {
			return data
		}
		if got != "online" && got != "state" && got != "waiting" && got != "countdown" {
			t.Fatalf("expected %q, got %q", typ, got)
		}
	}
}

func postJSON(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := testClient.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil && err != io.EOF {
		t.Fatalf("decoding response: %v", err)
	}
	return resp.StatusCode, m
}

func connectSSE(t *testing.T, srv *httptest.Server, id string) (*sseStream, string) {
	t.Helper()
	url := srv.URL + "/events"
	if id != "" {
		url += "?id=" + id
	}
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
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
		clientID, _ := data["id"].(string)
		if clientID == "" {
			st.close()
			t.Fatal("connected event carried no id")
		}
		return st, clientID
	}
}

// readCountdown consumes the matched + KA + CHI + shoot preamble of a match,
// asserting the expected types along the way.
func readCountdown(t *testing.T, st *sseStream, timeout time.Duration) {
	for _, want := range []string{"countdown", "countdown", "shoot"} {
		st.readEventTyp(t, want, timeout)
	}
}

func TestCPUIntegration(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, id := connectSSE(t, srv, "")
	defer st.close()

	if code, _ := postJSON(t, srv.URL+"/cpu", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/cpu status: %d", code)
	}

	st.readEventTyp(t, "matched", 5*time.Second)
	if code, _ := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/ready status: %d", code)
	}
	readCountdown(t, st, 5*time.Second)

	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "rock"}); code != 200 {
		t.Fatal("/move rejected the on-time pick")
	}

	data := st.readEventTyp(t, "result", 8*time.Second)
	outcome, _ := data["outcome"].(string)
	if outcome != "win" && outcome != "loss" && outcome != "draw" {
		t.Fatalf("unexpected outcome %q", outcome)
	}

	data = st.readEventTyp(t, "state", 5*time.Second)
	if data["state"] != "idle" {
		t.Fatalf("expected state idle, got %v", data)
	}
}

func TestPVPIntegration(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	stA, idA := connectSSE(t, srv, "")
	defer stA.close()
	stB, idB := connectSSE(t, srv, "")
	defer stB.close()

	for _, id := range []string{idA, idB} {
		if code, _ := postJSON(t, srv.URL+"/queue", map[string]any{"id": id}); code != 200 {
			t.Fatalf("/queue status for %q: %d", id, code)
		}
	}
	for _, st := range []*sseStream{stA, stB} {
		st.readEventTyp(t, "matched", 5*time.Second)
	}
	for _, id := range []string{idA, idB} {
		if code, _ := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
			t.Fatalf("/ready status for %q: %d", id, code)
		}
	}
	for _, st := range []*sseStream{stA, stB} {
		readCountdown(t, st, 5*time.Second)
	}

	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": idA, "move": "rock"}); code != 200 {
		t.Fatal("A move rejected")
	}
	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": idB, "move": "scissors"}); code != 200 {
		t.Fatal("B move rejected")
	}

	for _, st := range []*sseStream{stA, stB} {
		st.readEventTyp(t, "result", 8*time.Second)
		data := st.readEventTyp(t, "state", 5*time.Second)
		if data["state"] != "idle" {
			t.Fatalf("expected state idle, got %v", data)
		}
	}
}

// TestPVPSimultaneousMove submits both moves concurrently right after shoot and
// asserts neither gets lost: each side receives a consistent result.
func TestPVPSimultaneousMove(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	stA, idA := connectSSE(t, srv, "")
	defer stA.close()
	stB, idB := connectSSE(t, srv, "")
	defer stB.close()

	for _, id := range []string{idA, idB} {
		if code, _ := postJSON(t, srv.URL+"/queue", map[string]any{"id": id}); code != 200 {
			t.Fatalf("/queue status for %q: %d", id, code)
		}
	}
	for _, st := range []*sseStream{stA, stB} {
		st.readEventTyp(t, "matched", 5*time.Second)
	}
	for _, id := range []string{idA, idB} {
		postJSON(t, srv.URL+"/ready", map[string]any{"id": id})
	}
	for _, st := range []*sseStream{stA, stB} {
		readCountdown(t, st, 5*time.Second)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": idA, "move": "rock"}); code != 200 {
			t.Error("A move rejected")
		}
	}()
	go func() {
		defer wg.Done()
		if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": idB, "move": "paper"}); code != 200 {
			t.Error("B move rejected")
		}
	}()
	wg.Wait()

	for _, st := range []*sseStream{stA, stB} {
		st.readEventTyp(t, "result", 8*time.Second)
	}
}

// TestPVPDisconnectDuringMatch disconnects A while both are in the countdown
// and verifies B still gets a terminal opponent-left and returns to idle.
func TestPVPDisconnectDuringMatch(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	stA, idA := connectSSE(t, srv, "")
	defer stA.close()
	stB, idB := connectSSE(t, srv, "")
	defer stB.close()

	for _, id := range []string{idA, idB} {
		if code, _ := postJSON(t, srv.URL+"/queue", map[string]any{"id": id}); code != 200 {
			t.Fatalf("/queue status for %q: %d", id, code)
		}
	}
	for _, st := range []*sseStream{stA, stB} {
		st.readEventTyp(t, "matched", 5*time.Second)
	}
	for _, id := range []string{idA, idB} {
		if code, _ := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
			t.Fatalf("/ready status for %q: %d", id, code)
		}
	}

	stA.close()

	stB.readEventTyp(t, "opponent-left", 8*time.Second)
	data := stB.readEventTyp(t, "state", 5*time.Second)
	if data["state"] != "idle" {
		t.Fatalf("expected state idle, got %v", data)
	}
}

func TestEndpointValidation(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": "ghost", "move": "rock"}); code != 400 {
		t.Fatalf("move for unknown client: want 400, got %d", code)
	}

	st, id := connectSSE(t, srv, "")
	defer st.close()

	if code, _ := postJSON(t, srv.URL+"/queue", map[string]any{"id": id}); code != 200 {
		t.Fatal("/queue rejected a connected client")
	}
	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "rock"}); code != 400 {
		t.Fatalf("move while waiting: want 400, got %d", code)
	}
	if code, _ := postJSON(t, srv.URL+"/cancel", map[string]any{"id": id}); code != 200 {
		t.Fatal("/cancel rejected")
	}

	if code, _ := postJSON(t, srv.URL+"/cpu", map[string]any{"id": id}); code != 200 {
		t.Fatal("/cpu rejected")
	}
	st.readEventTyp(t, "matched", 5*time.Second)
	if code, _ := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/ready status: %d", code)
	}
	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "rock"}); code != 400 {
		t.Fatalf("move during countdown: want 400, got %d", code)
	}

	readCountdown(t, st, 5*time.Second)

	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "rock"}); code != 200 {
		t.Fatal("on-time move rejected")
	}
	// A second submission while a pick is still pending is 409; if the run loop
	// already consumed the first move the buffer is free and it is 200 (the
	// straggler is then drained at finishMatch). Both are legal.
	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "paper"}); code != 200 && code != 409 {
		t.Fatalf("duplicate move: want 200 or 409, got %d", code)
	}
	if code, _ := postJSON(t, srv.URL+"/character", map[string]any{"id": id, "character": "not-a-character"}); code != 400 {
		t.Fatalf("invalid character: want 400, got %d", code)
	}

	st.readEventTyp(t, "result", 8*time.Second)
	data := st.readEventTyp(t, "state", 5*time.Second)
	if data["state"] != "idle" {
		t.Fatalf("expected state idle, got %v", data)
	}
	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "rock"}); code != 400 {
		t.Fatalf("move after match: want 400, got %d", code)
	}
}

// TestReadyAckOnAbandonedMatchIsRejected covers the window the live t5 failure
// did NOT turn out to be, and which is worth closing anyway.
//
// finishMatch nils c.match, so by the time a client acks a match that has
// properly finished, handleReady already answers 400 "no active match" — correct,
// and covered by the requeue tests. The narrow gap is the window between
// advance(phaseCountdown, phaseDone) and finishMatch running: the phase is done
// but c.match is still set. An ack in that window used to be answered 200, which
// claims the countdown is coming for a match that will never run one.
func TestReadyAckOnAbandonedMatchIsRejected(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, id := connectSSE(t, srv, "")
	defer st.close()

	if code, _ := postJSON(t, srv.URL+"/cpu", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/cpu status: %d", code)
	}
	st.readEventTyp(t, "matched", 5*time.Second)

	// Drive the match to done but keep c.match set, which is exactly the window:
	// the phase advances before the teardown clears the pointer. h.client takes
	// h.mu itself, so it has to be called before the lock is held, not inside it.
	c := h.client(id)
	h.mu.Lock()
	m := c.match
	h.mu.Unlock()
	if m == nil {
		t.Fatal("no match attached to the client after matched")
	}
	m.advance(phaseCountdown, phaseDone)

	code, body := postJSON(t, srv.URL+"/ready", map[string]any{"id": id})
	if code != http.StatusConflict {
		t.Fatalf("/ready on an abandoned match = %d, want 409, not a 200 promising a countdown that cannot come (body %v)", code, body)
	}
	// The client renders this inline, so the message has to say something.
	if msg, _ := body["error"].(string); msg == "" {
		t.Errorf("/ready 409 body = %v, want a non-empty error message", body)
	}
}

// TestReadyAckWhileGateOpenStaysAccepted is the guard against over-correcting the
// check above into a regression. The gate is open for the whole countdown phase,
// not just the instant before the first ack, so a re-sent ack — which a
// reconnecting client does — must still be accepted while the match is live.
func TestReadyAckWhileGateOpenStaysAccepted(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, id := connectSSE(t, srv, "")
	defer st.close()

	if code, _ := postJSON(t, srv.URL+"/cpu", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/cpu status: %d", code)
	}
	st.readEventTyp(t, "matched", 5*time.Second)

	// First ack opens the gate.
	if code, body := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/ready while the gate is open = %d, want 200 (body %v)", code, body)
	}
	// Second ack is idempotent, and the match is still mid-countdown: accepting
	// it is what stops a reconnecting client from wedging itself.
	if code, body := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
		t.Errorf("/ready re-sent mid-countdown = %d, want 200 (body %v)", code, body)
	}
	readCountdown(t, st, 5*time.Second)
}

// A double-tap on Fight posts /cpu twice in one tick. The second request must be
// refused, not served: two live matches on one client interleave `matched` and
// `countdown` frames, the player's single pick is routed to whichever match
// c.match points at, and the orphan resolves with no human move — delivering
// `result: loss` / yourNote "timeout" for a round the player never played.
// finishMatch cannot clean that up (its stale-teardown guard suppresses the
// orphan's frame), so the server has to refuse the second match up front.
func TestSecondMatchRefusedForLiveClient(t *testing.T) {
	h := NewHub()
	srv := httptest.NewServer(h.routes())
	defer srv.Close()

	st, id := connectSSE(t, srv, "")
	defer st.close()

	if code, _ := postJSON(t, srv.URL+"/cpu", map[string]any{"id": id}); code != 200 {
		t.Fatalf("first /cpu status: %d", code)
	}
	st.readEventTyp(t, "matched", 5*time.Second)

	for _, path := range []string{"/cpu", "/queue"} {
		code, body := postJSON(t, srv.URL+path, map[string]any{"id": id})
		if code != http.StatusConflict {
			t.Fatalf("%s while in a match: status %d, want 409 (body %v)", path, code, body)
		}
		if body["error"] != "already in a match" {
			t.Fatalf("%s error: %q", path, body["error"])
		}
	}

	// The guard must not wedge the client: once the match tears down, c.match is
	// cleared and a fresh match is allowed.
	if code, _ := postJSON(t, srv.URL+"/ready", map[string]any{"id": id}); code != 200 {
		t.Fatal("/ready status")
	}
	readCountdown(t, st, 5*time.Second)
	if code, _ := postJSON(t, srv.URL+"/move", map[string]any{"id": id, "move": "rock"}); code != 200 {
		t.Fatal("/move rejected the on-time pick")
	}
	st.readEventTyp(t, "result", 8*time.Second)
	st.readEventTyp(t, "state", 5*time.Second)

	if code, body := postJSON(t, srv.URL+"/cpu", map[string]any{"id": id}); code != 200 {
		t.Fatalf("/cpu after teardown: status %d (body %v), want 200", code, body)
	}
	st.readEventTyp(t, "matched", 5*time.Second)
}
