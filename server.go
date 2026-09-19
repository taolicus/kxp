package main

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

const maxBodyBytes = 1 << 10

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
func logDroppedEvent(typ string, c *Client) {
	dropLogMu.Lock()
	defer dropLogMu.Unlock()
	if time.Since(lastDropLogAt) < 2*time.Second {
		return
	}
	lastDropLogAt = time.Now()
	log.Printf("kxp: dropped %q event for client %s (send backlog full)", typ, c.id)
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

	mu       sync.Mutex
	connID   string
	queueing bool
	match    *match
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
		logDroppedEvent(ev.Type, c)
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
	down    context.Context
	stop    context.CancelFunc
}

func NewHub() *Hub {
	down, stop := context.WithCancel(context.Background())
	return &Hub{clients: make(map[string]*Client), down: down, stop: stop}
}

// routes wires every HTTP endpoint to the hub. The static file server for the
// embedded web assets is the caller's (main.go) concern, so tests get the API
// surface without it.
func (h *Hub) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", h.handleEvents)
	mux.HandleFunc("POST /queue", h.handleQueue)
	mux.HandleFunc("POST /cancel", h.handleCancel)
	mux.HandleFunc("POST /cpu", h.handleCPU)
	mux.HandleFunc("POST /ready", h.handleReady)
	mux.HandleFunc("POST /move", h.handleMove)
	mux.HandleFunc("POST /character", h.handleCharacter)
	return mux
}

func (h *Hub) Shutdown() {
	h.stop()
}

func (h *Hub) getOrCreate(id string) *Client {
	h.mu.Lock()
	if id != "" {
		if c, ok := h.clients[id]; ok {
			h.mu.Unlock()
			return c
		}
		if validID(id) {
			c := newClient()
			c.id = id
			h.clients[id] = c
			h.mu.Unlock()
			h.broadcastOnline()
			return c
		}
	}
	c := newClient()
	c.id = newID(6)
	h.clients[c.id] = c
	h.mu.Unlock()
	h.broadcastOnline()
	return c
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`, msg)
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
	c := h.getOrCreate(r.URL.Query().Get("id"))

	fl, ok := w.(http.Flusher)
	if !ok {
		h.handlerError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	connID := c.beginConn()
	defer h.endConn(c, connID)

	if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
		h.handlerError(w, http.StatusInternalServerError, "streaming timeout unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	c.sendEv(evt("connected", h.snapshot(c)))

	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-h.down.Done():
			return
		case b := <-c.send:
			if _, err := w.Write(b); err != nil {
				return
			}
			fl.Flush()
		case <-tick.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

func (c *Client) beginConn() string {
	id := newID(4)
	c.mu.Lock()
	c.connID = id
	c.mu.Unlock()
	return id
}

func (h *Hub) endConn(c *Client, connID string) {
	c.mu.Lock()
	current := c.connID
	c.mu.Unlock()
	if current != connID {
		return
	}
	h.removeClient(c)
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
	h.mu.Unlock()
	c.cancel()
	if removed {
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
	out := map[string]any{"id": c.id, "state": "idle", "online": h.othersOnlineLocked()}
	if c.match != nil {
		m := c.match
		out["state"] = "ingame"
		out["phase"] = m.phaseName()
		if i := m.indexOfMoves(c.moves); i >= 0 {
			out["opponentName"] = m.opponentName(i)
			out["opponentCharacter"] = m.opponentCharacter(i)
		}
		if out["phase"] == "shoot" {
			out["windowMs"] = shootWindow.Milliseconds()
			out["shootAt"] = m.shootAt.UnixMilli()
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
		logDroppedEvent("raw", c)
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
	m.start()
}

// finishMatch tears down a finished or abandoned match: clears each client's
// match pointer, drains stale moves, and tells both sides to return to idle.
func (h *Hub) finishMatch(m *match, sides [2]side) {
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
	if !c.queueing {
		c.queueing = true
		h.queue = append(h.queue, c)
	}
	h.mu.Unlock()
	c.sendEv(evt("waiting", map[string]any{}))
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
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	m := h.makeMatch(newID(4), side{client: c}, side{bot: true, character: randomCharacterID()})
	h.startMatchLocked(m)
	h.mu.Unlock()
	w.Write([]byte("{}"))
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
		if time.Now().After(m.shootAt.Add(shootWindow)) {
			h.handlerError(w, http.StatusBadRequest, "too late")
			return
		}
	}
	msg := moveMsg{move: move, arrive: time.Now()}
	if req.SawPunAt > 0 && req.ClickedAt > 0 {
		msg.sawPun = req.SawPunAt
		msg.click = req.ClickedAt
	}
	select {
	case c.moves <- msg:
	default:
		h.handlerError(w, http.StatusConflict, "move already submitted")
		return
	}
	w.Write([]byte("{}"))
}
