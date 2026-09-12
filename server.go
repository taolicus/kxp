package main

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type sseEv struct {
	Type string
	Data any
}

func evt(t string, data any) sseEv {
	return sseEv{Type: t, Data: data}
}

func encodeEv(ev sseEv) []byte {
	b, err := json.Marshal(ev.Data)
	if err != nil {
		b = []byte("{}")
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", ev.Type, b))
}

type Client struct {
	id     string
	send   chan []byte
	moves  chan moveMsg
	alive  context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	connID   string
	queueing bool
	match    *match
}

func newClient() *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		send:   make(chan []byte, 64),
		moves:  make(chan moveMsg, 1),
		alive:  ctx,
		cancel: cancel,
	}
}

func (c *Client) sendEv(ev sseEv) {
	b := encodeEv(ev)
	select {
	case c.send <- b:
	default:
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
}

func NewHub() *Hub {
	return &Hub{clients: make(map[string]*Client)}
}

func (h *Hub) getOrCreate(id string) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	if id != "" {
		if c, ok := h.clients[id]; ok {
			return c
		}
		if validID(id) {
			c := newClient()
			c.id = id
			h.clients[id] = c
			return c
		}
	}
	c := newClient()
	c.id = newID(6)
	h.clients[c.id] = c
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

func (h *Hub) handleEvents(w http.ResponseWriter, r *http.Request) {
	c := h.getOrCreate(r.URL.Query().Get("id"))

	fl, ok := w.(http.Flusher)
	if !ok {
		h.handlerError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	connID := c.beginConn()
	defer h.endConn(c, connID)

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
	h.mu.Lock()
	if h.clients[c.id] == c {
		delete(h.clients, c.id)
	}
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	c.match = nil
	h.mu.Unlock()
	c.cancel()
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
	out := map[string]any{"id": c.id, "state": "idle"}
	if c.match != nil {
		out["state"] = "ingame"
		out["phase"] = c.match.phaseName()
	} else if c.queueing {
		out["state"] = "waiting"
	}
	return out
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
	m.phase.Store(phaseDone)
	h.mu.Lock()
	for _, s := range m.sides {
		if s.client != nil && s.client.match == m {
			s.client.match = nil
		}
	}
	h.mu.Unlock()
	for _, s := range m.sides {
		if s.client != nil {
			s.client.sendEv(evt("state", map[string]any{"state": "idle"}))
		}
	}
}

func (h *Hub) handleQueue(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.handlerError(w, http.StatusBadRequest, "bad request")
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.handlerError(w, http.StatusBadRequest, "bad request")
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
	h.mu.Unlock()
	w.Write([]byte("{}"))
}

func (h *Hub) handleCPU(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.handlerError(w, http.StatusBadRequest, "bad request")
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
	m := h.makeMatch(newID(4), side{client: c}, side{bot: true})
	h.startMatchLocked(m)
	h.mu.Unlock()
	w.Write([]byte("{}"))
}

func (h *Hub) handleMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string `json:"id"`
		Move string `json:"move"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.handlerError(w, http.StatusBadRequest, "bad request")
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
	msg := moveMsg{move: move, arrive: time.Now()}
	select {
	case c.moves <- msg:
	default:
	}
	w.Write([]byte("{}"))
}
