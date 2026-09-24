package main

import (
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const maxBodyBytes = 1 << 10

// Resource caps. Deliberately conservative yet unreachable in normal play:
// each live client holds a 64-slot send channel plus a goroutine on its
// /events stream, so capping the clients map bounds worst-case memory growth;
// the queue and match caps bound the same pressure from join spam.
const (
	maxClients = 256
	maxQueue   = 128
	maxMatches = 64

	// frameJournalCap bounds the per-client SSE frame journal (last frames
	// actually flushed to the client) that is logged on leave so a vanished
	// device's history can be correlated with its reconnect/beacon.
	frameJournalCap = 16
)

// sseWriteDeadline is the rolling per-write deadline on /events streams: it
// bounds how long a single frame write may block before the handler treats the
// connection as vanished (half-open peer, dead device) and reaps it. It is
// re-armed before every write, so an idle-but-healthy stream is never killed by
// its own interval; the deadline only fires when an actual write cannot
// complete. Together with TCP keepalive (main.go's ListenConfig) this is the
// "bounded SSE connection lifetime" that makes the online count reconcile down
// instead of ghosting +1. A var (not const) so the reap test can shrink it.
var sseWriteDeadline = 5 * time.Second

// side is the hub-level view of one side of a match: the concrete client plus
// match-time facts. Hub.makeMatch turns it into an engine matchParty.
type side struct {
	client    *Client
	bot       bool
	character string
}

var (
	dropLogMu     sync.Mutex
	lastDropLogAt time.Time
)

// logDroppedEvent logs a silently dropped push at most once per two seconds so
// a wedged SSE connection shows up in the server log instead of vanishing.
func logDroppedEvent(typ string, c *Client, m *HubMetrics) {
	if m != nil {
		m.incDropped()
	}
	dropLogMu.Lock()
	defer dropLogMu.Unlock()
	if time.Since(lastDropLogAt) < 2*time.Second {
		return
	}
	lastDropLogAt = time.Now()
	log.Printf("kxp: dropped %q event for client %s (send backlog full)", typ, c.id)
}

// statusWriter records the response status so the access-log middleware can
// report it once the handler returns. It still implements the Flusher and
// Unwrap hooks the SSE handler needs.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// accessLog logs one line per request — method, path, status, duration — so a
// production server's log shows every API hit including the 4xx/5xx outcomes.
// It also feeds the request counter for /metrics when given a non-nil metrics.
func accessLog(m *HubMetrics, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
		if m != nil {
			m.incRequest(sw.status)
		}
		log.Printf("kxp: access %s %s %d %s", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Microsecond))
	})
}

func encodeEv(ev event) []byte {
	b, err := json.Marshal(ev.Data)
	if err != nil {
		b = []byte("{}")
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", ev.Type, b))
}

type Client struct {
	id        string
	send      chan []byte
	moves     chan moveMsg
	alive     context.Context
	cancel    context.CancelFunc
	character string
	metrics   *HubMetrics

	mu       sync.Mutex
	connID   string
	queueing bool
	match    *match
	frames   []string
}

func newClient() *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		send:      make(chan []byte, 64),
		moves:     make(chan moveMsg, 1),
		alive:     ctx,
		cancel:    cancel,
		character: defaultCharacterID(),
	}
}

func (c *Client) sendEv(ev event) {
	b := encodeEv(ev)
	select {
	case c.send <- b:
	default:
		logDroppedEvent(ev.Type, c, c.metrics)
	}
}

func newID(n int) string {
	b := make([]byte, n)
	if _, err := cryptorand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

type Hub struct {
	mu      sync.Mutex
	clients map[string]*Client
	queue   []*Client
	active  atomic.Int32
	down    context.Context
	stop    context.CancelFunc
	limiter *rateLimiter
	metrics *HubMetrics
	started time.Time
}

func NewHub() *Hub {
	down, stop := context.WithCancel(context.Background())
	return &Hub{
		clients: make(map[string]*Client),
		down:    down,
		stop:    stop,
		limiter: newRateLimiter(rlCapacity, rlRefillPerSec, rlMaxEntries, nil),
		metrics: newHubMetrics(),
		started: time.Now(),
	}
}

// routes wires every HTTP endpoint to the hub. The static file server for the
// embedded web assets is the caller's (main.go) concern, so tests get the API
// surface without it.
func (h *Hub) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", h.handleEvents)
	mux.HandleFunc("POST /queue", h.rateLimit(h.handleQueue))
	mux.HandleFunc("POST /cancel", h.rateLimit(h.handleCancel))
	mux.HandleFunc("POST /cpu", h.rateLimit(h.handleCPU))
	mux.HandleFunc("POST /ready", h.rateLimit(h.handleReady))
	mux.HandleFunc("POST /move", h.rateLimit(h.handleMove))
	mux.HandleFunc("POST /report", h.rateLimit(h.handleReport))
	mux.HandleFunc("GET /characters", h.handleCharacters)
	mux.HandleFunc("POST /character", h.rateLimit(h.handleCharacter))
	mux.HandleFunc("GET /health", h.handleHealth)
	mux.HandleFunc("GET /metrics", h.handleMetrics)
	return mux
}

func (h *Hub) Shutdown() {
	h.stop()
}

// getOrCreate returns the client for id, minting a fresh anonymous one when
// id is empty or unknown. The second return is false when the hub is at
// capacity (len(clients) >= maxClients) and a new client would have to be
// created; existing clients are always returned so legit reconnects aren't
// blocked by the cap.
func (h *Hub) getOrCreate(id string) (*Client, bool) {
	h.mu.Lock()
	if id != "" {
		if c, ok := h.clients[id]; ok {
			h.mu.Unlock()
			return c, true
		}
	}
	if len(h.clients) >= maxClients {
		h.mu.Unlock()
		return nil, false
	}
	if id != "" && validID(id) {
		c := newClient()
		c.id = id
		c.metrics = h.metrics
		h.clients[id] = c
		h.metrics.incJoined()
		log.Printf("kxp: client %s join online=%d", c.id, len(h.clients))
		h.mu.Unlock()
		h.broadcastOnline()
		return c, true
	}
	c := newClient()
	c.id = newID(6)
	c.metrics = h.metrics
	h.clients[c.id] = c
	h.metrics.incJoined()
	log.Printf("kxp: client %s join online=%d", c.id, len(h.clients))
	h.mu.Unlock()
	h.broadcastOnline()
	return c, true
}

func validID(id string) bool {
	if len(id) > 64 || len(id) < 1 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

func (h *Hub) client(id string) *Client {
	if id == "" {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.clients[id]
}

func (h *Hub) handlerError(w http.ResponseWriter, code int, msg string) {
	h.metrics.incReject(code, msg)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`, msg)
	log.Printf("kxp: reject %d %q", code, msg)
}

func (h *Hub) decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			h.handlerError(w, http.StatusRequestEntityTooLarge, "body too large")
		} else {
			h.handlerError(w, http.StatusBadRequest, "bad request")
		}
		return err
	}
	return nil
}

func (h *Hub) handleEvents(w http.ResponseWriter, r *http.Request) {
	h.metrics.incStreamOpened()
	c, ok := h.getOrCreate(r.URL.Query().Get("id"))
	if !ok {
		h.handlerError(w, http.StatusServiceUnavailable, "too many clients")
		return
	}

	fl, ok := w.(http.Flusher)
	if !ok {
		h.handlerError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	// Reap tracking: a write that cannot complete (bounded by sseWriteDeadline)
	// means the peer is gone but the OS never told us — the classic half-open
	// /dev/null conn that used to count as online forever. We mark it reaped so
	// endConn can log a distinct line and bump the reaped counter; a normal
	// context cancellation stays a plain leave.
	reaped := false
	connID := c.beginConn()
	defer func() {
		removed := h.endConn(c, connID)
		if reaped && removed {
			h.metrics.incReaped()
			h.mu.Lock()
			n := len(h.clients)
			h.mu.Unlock()
			log.Printf("kxp: reap client %s online=%d (write deadline)", c.id, n)
		}
	}()

	// The rolling per-write deadline: re-armed immediately before every frame
	// so an idle-but-healthy stream is unaffected, while a write that blocks on
	// a vanished peer fails within sseWriteDeadline and reaps the connection.
	// SetWriteDeadline support is probed here once; per-frame arming treats any
	// failure as a reap (the conn is unusable either way).
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Time{}); err != nil {
		h.handlerError(w, http.StatusInternalServerError, "streaming timeout unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	writeFrame := func(b []byte) bool {
		rc.SetWriteDeadline(time.Now().Add(sseWriteDeadline))
		if _, err := w.Write(b); err != nil {
			return false
		}
		fl.Flush()
		return true
	}

	flushAndJournal := func(b []byte) bool {
		if !writeFrame(b) {
			return false
		}
		if typ := frameType(b); typ != "" {
			c.recordFrame(typ)
		}
		return true
	}

	if !flushAndJournal(encodeEv(evt("connected", h.snapshot(c)))) {
		reaped = true
		return
	}

	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-h.down.Done():
			return
		case b := <-c.send:
			if !flushAndJournal(b) {
				reaped = true
				return
			}
		case <-tick.C:
			if !writeFrame([]byte(": ping\n\n")) {
				reaped = true
				return
			}
		}
	}
}

// frameType extracts the SSE event name from an encoded frame ("event: x\n...")
// so the client-side frame journal can record what was actually flushed.
// Comment frames (": ping") carry no type and return "".
func frameType(b []byte) string {
	if len(b) > 7 && bytes.Equal(b[:7], []byte("event: ")) {
		if i := bytes.IndexByte(b, '\n'); i > 7 {
			return string(b[7:i])
		}
	}
	return ""
}

func (c *Client) beginConn() string {
	id := newID(4)
	c.mu.Lock()
	c.connID = id
	c.mu.Unlock()
	return id
}

// recordFrame appends the just-flushed SSE event type to the client's short
// frame journal. The journal is bounded (frameJournalCap) and logged on leave
// so a vanished/reaped device's last-seen history is visible in the server log
// next to the leave line.
func (c *Client) recordFrame(typ string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == frameJournalCap {
		copy(c.frames, c.frames[1:])
		c.frames = c.frames[:frameJournalCap-1]
	}
	c.frames = append(c.frames, typ)
}

func (c *Client) frameJournal() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.frames) == 0 {
		return ""
	}
	joined := make([]byte, 0, len(c.frames)*12)
	for i, f := range c.frames {
		if i > 0 {
			joined = append(joined, ',')
		}
		joined = append(joined, f...)
	}
	return string(joined)
}

func (h *Hub) endConn(c *Client, connID string) bool {
	c.mu.Lock()
	current := c.connID
	c.mu.Unlock()
	if current != connID {
		return false
	}
	h.removeClient(c)
	return true
}

func (h *Hub) removeClient(c *Client) {
	removed := false
	h.mu.Lock()
	if h.clients[c.id] == c {
		delete(h.clients, c.id)
		removed = true
	}
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	c.match = nil
	n := len(h.clients)
	h.mu.Unlock()
	c.cancel()
	if removed {
		h.metrics.incLeft()
		if j := c.frameJournal(); j != "" {
			log.Printf("kxp: client %s leave online=%d frames=%s", c.id, n, j)
		} else {
			log.Printf("kxp: client %s leave online=%d", c.id, n)
		}
		h.broadcastOnline()
	}
}

func (h *Hub) dequeueLocked(c *Client) {
	for i, q := range h.queue {
		if q == c {
			h.queue = append(h.queue[:i], h.queue[i+1:]...)
			return
		}
	}
}

func (h *Hub) snapshot(c *Client) map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[string]any{"id": c.id, "state": "idle", "online": h.othersOnlineLocked(), "now": time.Now().UnixMilli()}
	if c.match != nil {
		m := c.match
		out["state"] = "ingame"
		out["phase"] = m.phaseName()
		if i := m.indexOfMoves(c.moves); i >= 0 {
			out["opponentName"] = m.opponentName(i)
			out["opponentCharacter"] = m.opponentCharacter(i)
		}
		if (out["phase"] == "shoot" || out["phase"] == "countdown") && m.shootAt.Load() != 0 {
			out["windowMs"] = shootWindow.Milliseconds()
			out["shootAt"] = m.shootAtMs()
		}
		if out["phase"] == "countdown" && m.needsReady() && !m.bothReady() {
			out["pending"] = true
		}
	} else if c.queueing {
		out["state"] = "waiting"
	}
	return out
}

func (h *Hub) othersOnlineLocked() int {
	if n := len(h.clients); n > 0 {
		return n - 1
	}
	return 0
}

func (h *Hub) broadcastOnline() {
	h.mu.Lock()
	n := h.othersOnlineLocked()
	ev := encodeEv(evt("online", map[string]any{"count": n}))
	clients := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()
	for _, c := range clients {
		c.sendEvRaw(ev)
	}
}

func (c *Client) sendEvRaw(b []byte) {
	select {
	case c.send <- b:
	default:
		logDroppedEvent("raw", c, c.metrics)
	}
}

func (c *Client) drainMoves() {
	for {
		select {
		case <-c.moves:
		default:
			return
		}
	}
}

func (h *Hub) tryMatch() {
	h.mu.Lock()
	for len(h.queue) >= 2 {
		a := h.queue[0]
		b := h.queue[1]
		h.queue = h.queue[2:]
		a.queueing, b.queueing = false, false
		m := h.makeMatch(newID(4), side{client: a}, side{client: b})
		h.startMatchLocked(m)
	}
	h.mu.Unlock()
}

// makeMatch builds an engine match from concrete sides and wires the engine's
// callbacks back to the hub. Callers must hold h.mu.
func (h *Hub) makeMatch(id string, a, b side) *match {
	src := [2]side{a, b}
	m := newMatch(id)
	for i := range src {
		p := matchParty{name: "Opponent", character: src[i].character}
		if src[i].client == nil {
			p.bot = true
			p.name = "CPU"
		} else {
			p.character = src[i].client.character
			p.emit = src[i].client.sendEv
			p.moves = src[i].client.moves
			p.left = src[i].client.alive.Done()
		}
		m.sides[i] = p
	}
	if b.bot {
		m.botMove = make(chan moveMsg, 1)
	}
	m.requeue = func(i int) {
		s := src[i]
		if s.client == nil {
			return
		}
		h.mu.Lock()
		if s.client.alive.Err() == nil && !s.client.queueing {
			s.client.queueing = true
			h.queue = append(h.queue, s.client)
		}
		h.mu.Unlock()
		go h.tryMatch()
	}
	m.finish = func() { h.finishMatch(m, src) }

	for _, s := range src {
		if s.client != nil {
			s.client.drainMoves()
			s.client.match = m
		}
	}
	return m
}

func (h *Hub) startMatchLocked(m *match) {
	h.active.Add(1)
	m.start()
}

// finishMatch tears down a finished or abandoned match: clears each client's
// match pointer, drains stale moves, and tells both sides to return to idle.
func (h *Hub) finishMatch(m *match, sides [2]side) {
	h.active.Add(-1)
	m.advance(phaseShoot, phaseDone)
	m.advance(phaseCountdown, phaseDone)
	h.mu.Lock()
	for _, s := range sides {
		if s.client != nil && s.client.match == m {
			s.client.match = nil
		}
	}
	h.mu.Unlock()
	for _, s := range sides {
		if s.client != nil {
			s.client.drainMoves()
			s.client.sendEv(evt("state", map[string]any{"state": "idle"}))
		}
	}
}

func (h *Hub) handleQueue(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	if len(h.queue) >= maxQueue {
		h.mu.Unlock()
		h.handlerError(w, http.StatusServiceUnavailable, "queue full")
		return
	}
	if !c.queueing {
		c.queueing = true
		h.queue = append(h.queue, c)
	}
	h.mu.Unlock()
	c.sendEv(evt("waiting", map[string]any{"ts": time.Now().UnixMilli()}))
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("{}"))
	go h.tryMatch()
}

func (h *Hub) handleCancel(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	cancelled := false
	h.mu.Lock()
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
		cancelled = true
	}
	h.mu.Unlock()
	if cancelled {
		c.sendEv(evt("state", map[string]any{"state": "idle"}))
	}
	w.Write([]byte("{}"))
}

func (h *Hub) handleReady(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	m := c.match
	h.mu.Unlock()
	if m == nil {
		h.handlerError(w, http.StatusBadRequest, "no active match")
		return
	}
	if i := m.indexOfMoves(c.moves); i >= 0 {
		m.ackReady(i)
	}
	w.Write([]byte("{}"))
}

func (h *Hub) handleCPU(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	if h.active.Load() >= maxMatches {
		h.mu.Unlock()
		h.handlerError(w, http.StatusServiceUnavailable, "too many active matches")
		return
	}
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	m := h.makeMatch(newID(4), side{client: c}, side{bot: true, character: randomCharacterID()})
	h.startMatchLocked(m)
	h.mu.Unlock()
	w.Write([]byte("{}"))
}

func (h *Hub) handleCharacters(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(characters)
}

// handleHealth reports process liveness plus a few instantaneous gauges. It is
// deliberately exempt from rate limiting (a read-only probe) so monitors and
// the e2e readiness gate can always reach it.
func (h *Hub) handleHealth(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	online := len(h.clients)
	queue := len(h.queue)
	h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":        "ok",
		"uptime":        time.Since(h.started).Seconds(),
		"online":        online,
		"queue":         queue,
		"activeMatches": h.active.Load(),
	})
}

// handleMetrics returns the pollable counter snapshot. Read-only, exempt from
// rate limiting for the same reason as /health.
func (h *Hub) handleMetrics(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	online := len(h.clients)
	queue := len(h.queue)
	h.mu.Unlock()
	out := h.metrics.Copy()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"uptime":  h.metrics.uptime().Seconds(),
		"online":  online,
		"queue":   queue,
		"matches": h.active.Load(),
		"counts":  out,
	})
}

func (h *Hub) handleCharacter(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string `json:"id"`
		Character string `json:"character"`
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	if !validCharacter(req.Character) {
		h.handlerError(w, http.StatusBadRequest, "invalid character")
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	c.character = req.Character
	h.mu.Unlock()
	w.Write([]byte("{}"))
}

func (h *Hub) handleMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        string `json:"id"`
		Move      string `json:"move"`
		SawPunAt  int64  `json:"sawPunAt"`
		ClickedAt int64  `json:"clickedAt"`
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	move := Move(req.Move)
	if !ValidMove(move) {
		h.handlerError(w, http.StatusBadRequest, "invalid move")
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	// The phase/deadline check below is best-effort and races the run loop:
	// the deadline may fire between this check and the buffered send, or the
	// match may resolve. Either way the accepted move is never silently
	// corrupted: drainPending counts anything buffered before the deadline
	// fired, and a move that lands after the run loop captured its snapshot is
	// just drained at finishMatch (it can only lose a round that had already
	// effectively closed).
	m := c.match
	h.mu.Unlock()
	if m == nil {
		h.handlerError(w, http.StatusBadRequest, "no active match")
		return
	}
	switch phase := m.phase.Load(); phase {
	case phaseCountdown:
		h.handlerError(w, http.StatusBadRequest, "too early")
		return
	case phaseDone, phaseIdle:
		h.handlerError(w, http.StatusBadRequest, "match over")
		return
	case phaseShoot:
		if time.Now().After(m.deadline()) {
			h.handlerError(w, http.StatusBadRequest, "too late")
			return
		}
	}
	msg := moveMsg{move: move, arrive: time.Now()}
	if req.SawPunAt > 0 && req.ClickedAt > 0 {
		msg.sawPunAt = req.SawPunAt
		msg.clickedAt = req.ClickedAt
	}
	select {
	case c.moves <- msg:
	default:
		h.handlerError(w, http.StatusConflict, "move already submitted")
		return
	}
	w.Write([]byte("{}"))
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// handleReport accepts fire-and-forget client-side error beacons over the same
// POST surface the client already speaks. A beacon is a noisy, low-value
// request: it only exists to log what the *client* saw (SSE stall/failure,
// fetch error, a transition the machine rejected) so the server log can show
// both sides of a connectivity problem. Stale or unknown ids are deliberately
// accepted — a beacon from a client the hub already reaped is itself a datum.
// Rate-limited like every state-changing POST; the client throttles hard
// (kxp.js beaconGate) so a firehose of beacons can't trip it.
func (h *Hub) handleReport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Kind   string `json:"kind"`
		State  string `json:"state"`
		Detail string `json:"detail"`
		TS     int64  `json:"ts"`
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	kind := clip(req.Kind, 48)
	if kind == "" {
		h.handlerError(w, http.StatusBadRequest, "missing kind")
		return
	}
	h.metrics.incBeacon(kind)
	log.Printf("kxp: beacon id=%s kind=%s state=%s detail=%q ts=%d", clip(req.ID, 64), kind, clip(req.State, 48), clip(req.Detail, 256), req.TS)
	w.Write([]byte("{}"))
}
