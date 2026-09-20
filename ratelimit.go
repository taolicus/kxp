package main

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

// Default token-bucket limits. Tuned to never trip a legitimate session
// (including best-of-5 and arcade-ladder bursts) while capping floods.
const (
	rlCapacity     = 200.0 // burst tokens per IP
	rlRefillPerSec = 2.0   // sustained ~120 requests/min
	rlMaxEntries   = 4096  // bound the limiter's own map
)

type rateLimitEntry struct {
	tokens float64
	last   time.Time
}

// rateLimiter is a per-IP token bucket. It takes an injectable clock so tests
// can advance time deterministically.
type rateLimiter struct {
	mu         sync.Mutex
	capacity   float64
	refill     float64
	maxEntries int
	now        func() time.Time
	byIP       map[string]rateLimitEntry
}

func newRateLimiter(capacity, refillPerSec float64, maxEntries int, now func() time.Time) *rateLimiter {
	if now == nil {
		now = time.Now
	}
	return &rateLimiter{
		capacity:   capacity,
		refill:     refillPerSec,
		maxEntries: maxEntries,
		now:        now,
		byIP:       make(map[string]rateLimitEntry),
	}
}

// resetAfter is how long an idle IP takes to fully refill; entries idle that
// long are stale and safe to evict.
func (l *rateLimiter) resetAfter() time.Duration {
	return time.Duration(l.capacity / l.refill * float64(time.Second))
}

// evictLocked bounds the map at maxEntries, evicting fully-refilled entries
// first and falling back to the least recently used IP.
func (l *rateLimiter) evictLocked(now time.Time) {
	reset := l.resetAfter()
	for ip, e := range l.byIP {
		if now.Sub(e.last) >= reset {
			delete(l.byIP, ip)
		}
	}
	if len(l.byIP) < l.maxEntries {
		return
	}
	oldest := ""
	var oldestAt time.Time
	for ip, e := range l.byIP {
		if oldest == "" || e.last.Before(oldestAt) {
			oldest, oldestAt = ip, e.last
		}
	}
	delete(l.byIP, oldest)
}

// allow reports whether ip may take one token now. An empty ip passes through
// defensively.
func (l *rateLimiter) allow(ip string) bool {
	if ip == "" {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, ok := l.byIP[ip]
	if !ok {
		if len(l.byIP) >= l.maxEntries {
			l.evictLocked(now)
		}
		e = rateLimitEntry{tokens: l.capacity, last: now}
	} else {
		elapsed := now.Sub(e.last).Seconds()
		if elapsed > 0 {
			e.tokens += elapsed * l.refill
			if e.tokens > l.capacity {
				e.tokens = l.capacity
			}
			e.last = now
		}
	}
	if e.tokens < 1 {
		return false
	}
	e.tokens--
	l.byIP[ip] = e
	return true
}

// clientIP returns the client's IP for rate limiting. The server is
// direct-exposed today (systemd binary on :8080), so RemoteAddr is the real
// peer and can't be spoofed. If an nginx reverse proxy is added in front,
// switch this to the first X-Forwarded-For hop — nginx overwrites it, which is
// what makes it trustworthy; keying on XFF without a trusted proxy lets a
// client spoof any IP and bypass the limiter.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimit wraps a POST handler with a per-IP token bucket. Applied to the
// state-mutating endpoints; the long-lived GET /events stream is exempt.
func (h *Hub) rateLimit(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.limiter.allow(clientIP(r)) {
			w.Header().Set("Retry-After", fmtDuration(h.limiter.resetAfter()))
			h.handlerError(w, http.StatusTooManyRequests, "rate limited")
			return
		}
		next(w, r)
	}
}

func fmtDuration(d time.Duration) string {
	s := d.Seconds()
	if s < 1 {
		return "1"
	}
	return fmt.Sprintf("%.0f", s)
}
