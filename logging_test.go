package main

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func captureLog(t *testing.T) (*bytes.Buffer, func()) {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	return &buf, func() { log.SetOutput(prev) }
}

func TestLogAccessCapturesStatus(t *testing.T) {
	buf, restore := captureLog(t)
	defer restore()

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	})
	req := httptest.NewRequest("POST", "/move", nil)
	accessLog(next).ServeHTTP(httptest.NewRecorder(), req)

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
	accessLog(next).ServeHTTP(httptest.NewRecorder(), req)

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
	c, ok := h.getOrCreate("")
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
