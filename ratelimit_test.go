package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock(t time.Time) *fakeClock {
	return &fakeClock{now: t}
}

func (f *fakeClock) set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = t
}

func (f *fakeClock) get() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func TestTokenBucketRefillsOverTime(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	l := newRateLimiter(10, 2, 64, clock.get)

	for i := 0; i < 10; i++ {
		if !l.allow("1.2.3.4") {
			t.Fatalf("allow %d: denied, want granted below capacity", i)
		}
	}
	if l.allow("1.2.3.4") {
		t.Fatal("allow past capacity: granted, want denied")
	}

	clock.set(clock.get().Add(time.Second)) // refills 2 tokens
	if !l.allow("1.2.3.4") {
		t.Fatal("allow after 1s: denied, want granted")
	}
	if !l.allow("1.2.3.4") {
		t.Fatal("allow 2nd after 1s: denied, want granted")
	}
	if l.allow("1.2.3.4") {
		t.Fatal("allow past refilled bucket: granted, want denied")
	}

	clock.set(clock.get().Add(5 * time.Second)) // back to full
	for i := 0; i < 10; i++ {
		if !l.allow("1.2.3.4") {
			t.Fatalf("full-bucket allow %d: denied, want granted", i)
		}
	}
}

func TestTokenBucketPerIPIsolation(t *testing.T) {
	l := newRateLimiter(2, 1, 64, nil)
	if !l.allow("1.1.1.1") || !l.allow("1.1.1.1") {
		t.Fatal("first IP should exhaust its own 2-token bucket")
	}
	if l.allow("1.1.1.1") {
		t.Fatal("third request from drained IP: granted, want denied")
	}
	if !l.allow("2.2.2.2") {
		t.Fatal("unrelated IP shared the drained bucket")
	}
}

func TestTokenBucketEvictsBelowMaxEntries(t *testing.T) {
	clock := newFakeClock(time.Unix(0, 0))
	l := newRateLimiter(1, 0.01, 4, clock.get)
	for i := 0; i < 64; i++ {
		ip := fmt.Sprintf("10.0.0.%d", i)
		if !l.allow(ip) {
			t.Fatalf("fresh IP %s denied", ip)
		}
	}
	l.mu.Lock()
	n := len(l.byIP)
	l.mu.Unlock()
	if n > 4 {
		t.Fatalf("map grew to %d, want bounded at 4", n)
	}
	if !l.allow("10.0.0.0") {
		t.Fatal("evicted IP should be re-admittable as a fresh entry")
	}
}

func TestEmptyIPPassesThrough(t *testing.T) {
	l := newRateLimiter(1, 1, 4, nil)
	if !l.allow("") {
		t.Fatal("empty IP must never be denied (defensive pass-through)")
	}
}

func postWithIP(h *Hub, path, ip, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = ip
	rr := httptest.NewRecorder()
	h.routes().ServeHTTP(rr, req)
	return rr
}

func TestRateLimitRejectsOverLimit(t *testing.T) {
	h := NewHub()
	h.limiter = newRateLimiter(3, 0.01, 64, nil)
	ip := "198.51.100.10:5555"
	body := `{"id":"x"}`
	for i := 0; i < 3; i++ {
		rr := postWithIP(h, "/queue", ip, body)
		if rr.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d limited early", i)
		}
	}
	rr := postWithIP(h, "/queue", ip, body)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rr.Code)
	}
	if rl := rr.Header().Get("Retry-After"); rl == "" {
		t.Error("over-limit response missing Retry-After")
	}
	if !strings.Contains(rr.Body.String(), "rate limited") {
		t.Errorf("body = %s, want rate limited", rr.Body.String())
	}
}

func TestRateLimitPerRouterIsolation(t *testing.T) {
	h := NewHub()
	h.limiter = newRateLimiter(3, 0.01, 64, nil)
	body := `{"id":"x"}`
	for i := 0; i < 4; i++ {
		postWithIP(h, "/cpu", "198.51.100.20:5555", body)
	}
	rr := postWithIP(h, "/cpu", "198.51.100.21:5555", body)
	if rr.Code == http.StatusTooManyRequests {
		t.Fatal("other IP was rate limited by a drained neighbor")
	}
	rr = postWithIP(h, "/cpu", "198.51.100.20:5555", body)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("drained IP not limited, status = %d", rr.Code)
	}
}

func TestRateLimitMissingRemoteAddrPasses(t *testing.T) {
	h := NewHub()
	h.limiter = newRateLimiter(0, 0.01, 64, nil) // no tokens at all
	rr := postWithIP(h, "/queue", "", `{"id":"x"}`)
	if rr.Code == http.StatusTooManyRequests {
		t.Fatal("missing RemoteAddr should bypass the limiter")
	}
}
