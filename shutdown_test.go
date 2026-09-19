package main

import (
	"bufio"
	"net/http"
	"net/http/httptest"
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
