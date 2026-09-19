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

type sseEv struct {
	Type string
	Data any
}

func evt(t string, data any) sseEv {
	return sseEv{Type: t, Data: data}
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

func encodeEv(ev sseEv) []byte {
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

func (c *Client) sendEv(ev sseEv) {
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
		if out["phase"] == "shoot" {
			out["windowMs"] = shootWindow.Milliseconds()
			out["shootAt"] = m.shootAt.UnixMilli()
		}
		for i, s := range m.sides {
			if s.client == c {
				out["opponentName"] = m.opponentName(i)
				out["opponentCharacter"] = m.opponentCharacter(i)
				break
			}
		}
		if out["phase"] == "countdown" && c.match.needsReady() && !c.match.bothReady() {
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

func (h *Hub) startMatchLocked(m *match) {
	for _, s := range m.sides {
		if s.client != nil {
			s.client.match = m
		}
	}
	m.start()
}

func (h *Hub) endMatch(m *match) {
	m.advance(phaseShoot, phaseDone)
	m.advance(phaseCountdown, phaseDone)
	h.mu.Lock()
	for _, s := range m.sides {
		if s.client != nil && s.client.match == m {
			s.client.match = nil
		}
	}
	h.mu.Unlock()
	for _, s := range m.sides {
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
	for i, s := range m.sides {
		if s.client == c {
			m.ackReady(i)
			break
		}
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
