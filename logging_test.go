package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// logSink is a log destination that can be read while it is being written. A
// bare bytes.Buffer cannot: a match goroutine from a previous test may still be
// logging into it when the current test reads, and that unsynchronised pair is
// what turned a leaked goroutine into a CI -race failure on
// TestSSEFrameJournalLoggedOnLeave
// (docs/tasks/open/test-helper-goroutine-leak.md). The leak is fixed at its
// source -- see stopHub -- and this closes the other half, because a test sink
// that any live goroutine can write is a trap for the next one.
type logSink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *logSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *logSink) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

func captureLog(t *testing.T) (*logSink, func()) {
	t.Helper()
	sink := &logSink{}
	prev := log.Writer()
	log.SetOutput(sink)
	return sink, func() { log.SetOutput(prev) }
}

func TestLogAccessCapturesStatus(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	})
	req := httptest.NewRequest("POST", "/move", nil)
	accessLog(nil, next).ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if !strings.Contains(out, "POST /move 400") {
		t.Errorf("access log missing method/path/status; got: %q", out)
	}
}

func TestLogAccessReportsOKWithoutWriteHeader(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("{}"))
	})
	req := httptest.NewRequest("GET", "/characters", nil)
	accessLog(nil, next).ServeHTTP(httptest.NewRecorder(), req)

	if !strings.Contains(buf.String(), "GET /characters 200") {
		t.Errorf("access log missing implicit 200; got: %q", buf.String())
	}
}

func TestRejectLogsStatusCodeAndMessage(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	h := NewHub()
	rec := httptest.NewRecorder()
	h.handlerError(rec, http.StatusConflict, "move already submitted")

	if code := rec.Code; code != http.StatusConflict {
		t.Errorf("status = %d, want %d", code, http.StatusConflict)
	}
	if !strings.Contains(buf.String(), "reject 409") || !strings.Contains(buf.String(), "move already submitted") {
		t.Errorf("reject log missing code/message; got: %q", buf.String())
	}
}

func TestJoinLeaveLoggedWithLiveCount(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	h := NewHub()
	c, ok := h.getOrCreate("", "")
	if !ok {
		t.Fatal("getOrCreate failed")
	}
	if !strings.Contains(buf.String(), "join online=1") {
		t.Errorf("join log missing; got: %q", buf.String())
	}

	h.removeClient(c)
	if !strings.Contains(buf.String(), "leave online=0") {
		t.Errorf("leave log missing; got: %q", buf.String())
	}
}

func TestStatusWriterPassesFlusherThrough(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusWriter{ResponseWriter: rec}
	var w http.ResponseWriter = sw
	if _, ok := w.(http.Flusher); !ok {
		t.Error("statusWriter should satisfy http.Flusher for the SSE handler")
	}
	sw.Flush()
}
