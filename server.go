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
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// maxBodyBytes caps an accepted POST body. A var, not a const, so an operator
// can set -max-body-bytes; the resource caps below stay compiled in, because
// they bound the process's own memory rather than an operating value a
// deployment tunes.
var maxBodyBytes = 1 << 10

// Resource caps. Deliberately conservative yet unreachable in normal play:
// each live client holds a 64-slot send channel plus a goroutine on its
// /events stream, so capping the clients map bounds worst-case memory growth;
// the queue and match caps bound the same pressure from join spam.
const (
	maxClients = 256
	maxQueue   = 128
	maxMatches = 64
	// maxPlayers bounds the player registry (persistent browser ids), which
	// accumulates rather than tracking concurrent connections. Over the cap the
	// oldest identity is dropped; nothing durable is keyed to a player yet, so a
	// dropped browser only receives a fresh pid on its next visit.
	maxPlayers = 4096

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
	pid       string
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

// queueEntry is one waiting player and the mode it is waiting for. The mode
// rides the entry rather than the client because it is a request, not a
// property: the same player may re-post with a different length while still
// waiting, and what pairs is the last thing they asked for.
type queueEntry struct {
	client       *Client
	roundsTarget int
	drawEnds     bool
}

type challengeEntry struct {
	token        string
	creatorPid   string
	roundsTarget int
	drawEnds     bool
	match        *match // set when paired
}

// player is the server's per-player record, keyed by the persistent browser id
// (pid) rather than the connection id, so it outlives any single SSE stream.
// Nothing durable hangs off it yet; later slices key matchmaking reservations
// and ladder progress here.
type player struct {
	id string
}

type Hub struct {
	mu         sync.Mutex
	clients    map[string]*Client
	players    map[string]*player
	playerFIFO []string // insertion order, for bounded eviction
	queue      []queueEntry
	active     atomic.Int32
	down       context.Context
	stop       context.CancelFunc
	limiter    *rateLimiter
	metrics    *HubMetrics
	started    time.Time
	challenges map[string]*challengeEntry // token -> challenge
	challenge  map[string]*challengeEntry // creator pid -> challenge (open)
}

func NewHub() *Hub {
	down, stop := context.WithCancel(context.Background())
	return &Hub{
		clients:    make(map[string]*Client),
		players:    make(map[string]*player),
		challenges: make(map[string]*challengeEntry),
		challenge:  make(map[string]*challengeEntry),
		down:       down,
		stop:       stop,
		limiter:    newRateLimiter(rlCapacity, rlRefillPerSec, rlMaxEntries, nil),
		metrics:    newHubMetrics(),
		started:    time.Now(),
	}
}

// backgrounds is the roster of match stages, in the same order as the BGS array
// in web/app.js. The server sends the *choice* and never the bytes: the animated
// and reduced-motion WebPs stay client-side assets, and only the name travels.
//
// The two lists have to agree, because a client that is handed a name it does not
// recognise has to fall back to picking for itself -- and a server-side entry with
// no client-side counterpart would mean the two players quietly saw different
// stages. TestBackgroundRosterMatchesTheClient guards that by reading both.
var backgrounds = []string{"pool", "forest", "tomb", "arena", "portal"}

// pickBackground chooses one stage for a whole match. Called once per match, not
// once per side, so both players are told the same thing.
func pickBackground() string {
	return backgrounds[rand.IntN(len(backgrounds))]
}

// routes wires every HTTP endpoint to the hub. The static file server for the
// embedded web assets is the caller's (main.go) concern, so tests get the API
// surface without it.
func (h *Hub) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /events", h.handleEvents)
	mux.HandleFunc("POST /queue", h.rateLimit(h.handleQueue))
	mux.HandleFunc("POST /cancel", h.rateLimit(h.handleCancel))
	mux.HandleFunc("POST /challenge", h.rateLimit(h.handleChallenge))
	mux.HandleFunc("POST /join", h.rateLimit(h.handleJoin))
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

// getOrCreate returns the client for the connection id, minting a fresh
// anonymous one when id is empty or unknown. The persistent player id (pid) is
// resolved here too, but is deliberately separate from id: id names the
// connection, so a newer stream replaces an older one, while pid names the
// player across connections (two tabs) and reloads. The second return is false
// when the hub is at capacity (len(clients) >= maxClients) and a new client
// would have to be created; existing clients are always returned so legit
// reconnects aren't blocked by the cap.
func (h *Hub) getOrCreate(id, pid string) (*Client, bool) {
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
	c := newClient()
	c.metrics = h.metrics
	c.pid = h.resolvePlayerLocked(pid)
	if id != "" && validID(id) {
		c.id = id
	} else {
		c.id = newID(6)
	}
	h.clients[c.id] = c
	h.metrics.incJoined()
	log.Printf("kxp: client %s join online=%d", c.id, len(h.clients))
	h.mu.Unlock()
	h.broadcastOnline()
	return c, true
}

// resolvePlayerLocked returns the pid to attach to a new connection. A pid the
// server issued before is reattached; any other value -- absent, malformed, or
// never issued -- mints and registers a fresh player. The server is the source
// of the pid, so a client cannot choose its own identity. The registry is
// bounded by insertion order: the oldest is dropped when it fills, which only
// costs a dropped browser one fresh pid, because nothing durable is keyed to a
// player yet.
func (h *Hub) resolvePlayerLocked(pid string) string {
	if pid != "" && validID(pid) {
		if p, ok := h.players[pid]; ok {
			return p.id
		}
	}
	id := newID(6)
	if len(h.playerFIFO) >= maxPlayers {
		oldest := h.playerFIFO[0]
		h.playerFIFO = h.playerFIFO[1:]
		delete(h.players, oldest)
	}
	h.players[id] = &player{id: id}
	h.playerFIFO = append(h.playerFIFO, id)
	return id
}

// creatorClientLocked returns a live connection for pid, or nil if the player
// has no stream. A reservation belongs to the player, so whichever of its
// connections is present is the one that plays; the lookup is under h.mu
// because h.clients is plain state.
func (h *Hub) creatorClientLocked(pid string) *Client {
	if pid == "" {
		return nil
	}
	for _, c := range h.clients {
		if c.pid == pid {
			return c
		}
	}
	return nil
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
	r.Body = http.MaxBytesReader(w, r.Body, int64(maxBodyBytes))
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
	c, ok := h.getOrCreate(r.URL.Query().Get("id"), r.URL.Query().Get("pid"))
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
	// An open reservation is deliberately *not* dropped here. It is keyed to the
	// player (pid), not this connection, so a backgrounded phone or a refreshed
	// tab must not spend the link a friend may still claim. The reservation ends
	// by claim, cancel, match end, or (later) a TTL -- never by a stream closing.
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

// indexOfQueuedLocked finds the entry for c, or -1. Shared by dequeue and by
// handleQueue, where a re-post while waiting has to update the entry that is
// already there rather than queueing the same player twice.
func (h *Hub) indexOfQueuedLocked(c *Client) int {
	for i, e := range h.queue {
		if e.client == c {
			return i
		}
	}
	return -1
}

func (h *Hub) dequeueLocked(c *Client) {
	if i := h.indexOfQueuedLocked(c); i >= 0 {
		h.queue = append(h.queue[:i], h.queue[i+1:]...)
	}
}

func (h *Hub) snapshot(c *Client) map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[string]any{"id": c.id, "state": "idle", "online": h.othersOnlineLocked(), "now": time.Now().UnixMilli()}
	if c.pid != "" {
		out["pid"] = c.pid
	}
	if c.match != nil {
		m := c.match
		out["state"] = "ingame"
		out["phase"] = m.phaseName()
		if i := m.indexOfMoves(c.moves); i >= 0 {
			out["opponentName"] = m.opponentName(i)
			out["opponentCharacter"] = m.opponentCharacter(i)
			// The announced stage travels on the snapshot too, not just on
			// `matched`, because a client that reconnects mid-handshake never sees
			// `matched` -- it arrives straight at snapshot:matched. Without this it
			// would fall back to picking for itself and quietly land in a different
			// arena than its opponent, which is the one thing a shared stage exists
			// to prevent.
			out["background"] = m.background
		}
		// "preparing" is deliberately absent: the deadline is fixed at the far
		// side of that phase, so there is nothing to leak during it.
		if (out["phase"] == "shoot" || out["phase"] == "countdown") && m.hasShootAt() {
			out["windowMs"] = shootWindow.Milliseconds()
			out["shootAt"] = m.shootAtMs()
		}
		// pending means "this client is mid-handshake and must re-admit and
		// re-ack", which is only true while the gate is still open and not yet
		// satisfied. That is phasePreparing, and the between-rounds pause and
		// gate of an online series (where the phase reads done or countdown and
		// betweenRounds is what says a handshake is outstanding) -- once the
		// countdown of a round is actually running, the gate is closed by
		// definition.
		if (out["phase"] == "preparing" || m.betweenRounds.Load()) && !m.allHumanReady() {
			out["pending"] = true
		}
	} else if ch, ok := h.challenge[c.pid]; ok {
		// A creator waiting on a link is waiting, and the snapshot is the only
		// frame a reconnect gets. Without this branch it reads `idle`, the
		// client's snapshot:idle edge walks the creator to the lobby, and the
		// link it shared disappears from the screen even though the challenge is
		// still open. The token rides back because the creator's *own* URL does
		// not carry it -- only the claimant's does -- so this is the one way a
		// reconnect (or a reload) can rebuild the link on screen.
		out["state"] = "waiting"
		out["challenge"] = ch.token
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

// tryMatch pairs waiting players who are waiting for the same match: equal
// roundsTarget and equal drawEnds, because those two fields are the mode and a
// pair that disagrees on either would be playing a match only one of them
// asked for. Scanned FIFO -- the first pair in queue order that agrees wins --
// so a player whose length nobody else wants keeps their seat and their place
// rather than being bounced to the back of the queue. Callers must hold h.mu;
// the pass is idempotent, so a re-run that finds nothing to pair does nothing.
func (h *Hub) tryMatch() {
	h.mu.Lock()
	for {
		i, j := h.firstEqualPairLocked()
		if i < 0 {
			break
		}
		// Captured before either removal: j > i, so taking j out first leaves
		// i pointing at the same entry it did before.
		a, b := h.queue[i], h.queue[j]
		h.queue = append(h.queue[:j], h.queue[j+1:]...)
		h.queue = append(h.queue[:i], h.queue[i+1:]...)
		a.client.queueing, b.client.queueing = false, false
		m := h.makeMatch(newID(4), a.roundsTarget, side{client: a.client}, side{client: b.client})
		// The pairing carried the mode; the match must carry it too. makeMatch
		// defaults drawEnds from the target, which agrees for every length the
		// lobby offers today, but an entry may name either field independently
		// (handleQueue decodes drawEnds the way /cpu does), so the entry wins.
		m.drawEnds = a.drawEnds
		h.startMatchLocked(m)
	}
	h.mu.Unlock()
}

// firstEqualPairLocked returns the queue indices of the first pair of entries
// waiting for the same mode, or (-1, -1) when there is none.
func (h *Hub) firstEqualPairLocked() (int, int) {
	for i := 0; i < len(h.queue); i++ {
		for j := i + 1; j < len(h.queue); j++ {
			if h.queue[i].roundsTarget == h.queue[j].roundsTarget &&
				h.queue[i].drawEnds == h.queue[j].drawEnds {
				return i, j
			}
		}
	}
	return -1, -1
}

// makeMatch builds an engine match from concrete sides and wires the engine's
// callbacks back to the hub. Callers must hold h.mu.
func (h *Hub) makeMatch(id string, roundsTarget int, a, b side) *match {
	src := [2]side{a, b}
	m := newMatch(id, roundsTarget)
	m.background = pickBackground()
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
	// A CPU match's human goes back to the lobby, never onto the online queue:
	// they asked for a CPU round, and dropping them into the PvP queue would
	// silently change the mode they are in. The closure used to be identical
	// for both modes, so a CPU handshake timeout put the player into the queue
	// for a human opponent they never requested.
	cpu := src[1].client == nil
	m.requeue = func(i int) bool {
		s := src[i]
		if s.client == nil || cpu {
			return false
		}
		h.mu.Lock()
		if s.client.alive.Err() == nil && !s.client.queueing {
			s.client.queueing = true
			h.queue = append(h.queue, queueEntry{
				client:       s.client,
				roundsTarget: m.roundsTarget,
				drawEnds:     m.drawEnds,
			})
		}
		queued := s.client.queueing
		h.mu.Unlock()
		if queued {
			go h.tryMatch()
		}
		return queued
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
	m.advance(phasePreparing, phaseDone)
	// A side can be re-paired into a *new* match before this teardown runs: an
	// abandoned handshake re-queues both sides, and requeue -> tryMatch ->
	// makeMatch overwrites their match pointer. Telling such a side to go idle
	// would drop the client out of a match it is already playing — the browser
	// reads the frame as a stateIdle edge out of matched and returns to the
	// lobby while the server still holds it in the round. So the teardown frame
	// is per-side and conditional: only a side still in *this* match is told to
	// go idle. Decided under the lock, because c.match is plain state and an
	// unlocked read here would be a data race.
	var teardown [2]bool
	h.mu.Lock()
	for i, s := range sides {
		if s.client != nil && s.client.match == m {
			s.client.match = nil
			teardown[i] = true
			// Consume any open challenge involving this side (match produced)
			if ch, ok := h.challenge[s.client.pid]; ok {
				delete(h.challenge, s.client.pid)
				if ch.token != "" {
					delete(h.challenges, ch.token)
				}
			}
		}
	}
	// Also consume challenges that reference this match
	for tok, ch := range h.challenges {
		if ch.match == m {
			delete(h.challenges, tok)
			if ch.creatorPid != "" {
				delete(h.challenge, ch.creatorPid)
			}
		}
	}
	h.mu.Unlock()
	// A cancelled handshake is told to the client so a bounced player learns the
	// round was *cancelled* rather than lost. Both fields are additive and
	// server-generated (never taken from request input, so there is no injection
	// surface): a client that predates them ignores them and behaves exactly as
	// before. Sending them on `state idle` rather than swapping the event type
	// for `waiting` is deliberate — `waiting` has no `matched -> waiting` edge in
	// the client machine, so a stale tab open across a deploy would strand itself
	// on the game screen with a rejected transition.
	reason := m.abandonReason()
	for i, s := range sides {
		if s.client == nil {
			continue
		}
		// Unconditional: the move channel is this client's own, and a re-paired
		// client must not start its new round on its old round's buffered pick.
		s.client.drainMoves()
		if teardown[i] {
			payload := map[string]any{"state": "idle"}
			if reason != "" {
				payload["reason"] = reason
			}
			if m.requeued[i] {
				payload["requeued"] = true
			}
			s.client.sendEv(evt("state", payload))
		}
	}
}

func (h *Hub) handleQueue(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID           string
		RoundsTarget int
		DrawEnds     *bool
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	// The length is validated against the same closed set /cpu offers, because
	// the queue is what has to pair it: a target nobody else can name would sit
	// in the queue forever, and one outside the offer would be a series the
	// lobby never described. Absent means one round -- what the lobby's plain
	// button has always asked the queue for -- rather than /cpu's series
	// default; drawEnds follows the target unless the request names it, again
	// the same way. So what a client can ask the queue for is what it can ask
	// a CPU match for, default aside.
	target := req.RoundsTarget
	if target == 0 {
		target = 1
	}
	if !validSeriesTarget(target) {
		h.handlerError(w, http.StatusBadRequest, "unsupported roundsTarget")
		return
	}
	drawEnds := target <= 1
	if req.DrawEnds != nil {
		drawEnds = *req.DrawEnds
	}
	h.mu.Lock()
	// Same invariant as handleCPU: one client, at most one live match. Without
	// this a client mid-round could be dropped into the queue and paired into a
	// concurrent match, with the same interleaved-stream result.
	if c.match != nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "already in a match")
		return
	}
	if len(h.queue) >= maxQueue {
		h.mu.Unlock()
		h.handlerError(w, http.StatusServiceUnavailable, "queue full")
		return
	}
	// Waiting is one seat, not one seat per request: re-posting updates the
	// mode the seat is waiting for, so a player who changes their length in the
	// lobby changes what they will be paired with instead of acquiring a
	// second place in the queue.
	// A player with an open challenge cannot be silently queue-killed; challenge takes precedence in intent.
	if _, ok := h.challenge[c.pid]; ok {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "challenge already open")
		return
	}
	if i := h.indexOfQueuedLocked(c); i >= 0 {
		h.queue[i].roundsTarget = target
		h.queue[i].drawEnds = drawEnds
	} else {
		c.queueing = true
		h.queue = append(h.queue, queueEntry{client: c, roundsTarget: target, drawEnds: drawEnds})
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
	// Cancel is the player's own intent to spend the link, so it drops the
	// reservation keyed to this player. Both maps are guarded by h.mu, so the
	// drop must be inside the lock. A disconnect is not this path: the
	// reservation is keyed to the player, so a closed stream leaves it open.
	if ch, ok := h.challenge[c.pid]; ok {
		delete(h.challenge, c.pid)
		if ch.token != "" {
			delete(h.challenges, ch.token)
		}
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
	// The gate is open while the match is still in a phase waitReady may be
	// held in -- preparing, where start() puts it, and countdown, where the
	// between-rounds gate stands after judge's pause -- plus the pause itself:
	// betweenRounds is what says a client may re-ack while the phase reads
	// done, because the result frame it just received announced a next round
	// whose gate is already open. Once the gate has closed (a timeout, a
	// departure, the match ending) the flag is cleared and the match has
	// advanced to done, and no countdown will ever follow.
	//
	// Acking such a match must not answer 200. The client acks from the end of
	// its `matched` handler and then waits for the countdown, so a 200 is read
	// as "the countdown is coming". On a slow link the ack itself can outlast
	// the 8s gate, and answering 200 there tells a waiting client to sit still
	// for a frame that can never arrive — the silent-stuck shape in
	// docs/issues/silent-stuck.md, reached by telling the client it succeeded.
	// 409 says the
	// gate is gone, which the client can act on.
	// The gate is open across both phasePreparing and phaseCountdown: acks are
	// what *closes* the preparing phase, so rejecting anything but phaseCountdown
	// would reject every ack that matters. It closes at the end of phaseCountdown,
	// where a timeout or a departure has already moved the match to done.
	if p := m.phase.Load(); p != phasePreparing && p != phaseCountdown && !m.betweenRounds.Load() {
		h.handlerError(w, http.StatusConflict, "ready gate closed")
		return
	}
	i := m.indexOfMoves(c.moves)
	if i < 0 {
		// The client holds a match pointer whose side list does not contain it.
		// This was unreachable as far as I could trace -- moves is set once at
		// makeMatch and never cleared, so the pointer stays findable for as long
		// as the match exists -- but the fallthrough answered 200 for an ack that
		// had not been recorded against anybody, which is the one thing this
		// handler must never do. A 200 is read as "the countdown is coming", so
		// the client would sit waiting on a gate nothing is holding open. The
		// cost of the guard is a rejected ack in a state that should not occur;
		// the cost of no guard is a round that never arrives.
		h.handlerError(w, http.StatusConflict, "not a side of this match")
		return
	}
	m.ackReady(i)
	w.Write([]byte("{}"))
}

// seriesOffer is the series lengths a match may be asked for, as decisive round
// wins that end it -- CPU or online, since the queue has to pair a length and
// only what it can pair may be named. A closed set rather than a range: the
// lobby offers these and no others, so a target on the wire is always something
// the player was shown. Accepting any number would let a hand-written request
// invent a series the game has never described.
var seriesOffer = []int{1, defaultSeriesTarget}

func validSeriesTarget(n int) bool {
	for _, t := range seriesOffer {
		if n == t {
			return true
		}
	}
	return false
}

func (h *Hub) handleCPU(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID                string
		RoundsTarget      int
		OpponentCharacter string
		DrawEnds          *bool
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	// Absent means the client predates the choice, so it gets the default rather
	// than an error: the field is additive and a tab open across the deploy must
	// still be able to start a match.
	target := req.RoundsTarget
	if target == 0 {
		target = defaultSeriesTarget
	}
	if !validSeriesTarget(target) {
		h.handlerError(w, http.StatusBadRequest, "unsupported roundsTarget")
		return
	}
	// Whether a drawn round ends the match. Absent means the inference one round
	// always had -- a match of one round is whatever that round came to -- so an
	// older client is unaffected. The ladder is the only caller that says
	// otherwise: it always asks for replays, because a drawn round must not
	// decide a floor. Pointer rather than plain bool because absent and explicit
	// false are different requests here.
	drawEnds := target <= 1
	if req.DrawEnds != nil {
		drawEnds = *req.DrawEnds
	}
	// Which fighter the bot plays, for a ladder floor. Absent means the random
	// pick this handler always made, so an older client and every probe are
	// unaffected. Validated against the roster rather than passed through: the
	// engine stores it on the side and sends it to the client, so an unvalidated
	// string would put an unknown name on the wire and in the opponent slot.
	opponent := randomCharacterID()
	if req.OpponentCharacter != "" {
		if !validCharacter(req.OpponentCharacter) {
			h.handlerError(w, http.StatusBadRequest, "invalid opponent character")
			return
		}
		opponent = req.OpponentCharacter
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	// A client that already holds a live match must not be given a second one.
	// Both requests are idempotent-ish from the browser's side but not from the
	// server's: a double-tap on Fight posts /cpu twice in the same tick, and the
	// second makeMatch would overwrite c.match, orphaning the first match. Both
	// loops then drive the same event stream, so the client sees two `matched`
	// and two `countdown` frames for one round; its single pick is routed to
	// whichever match c.match points at, and the orphan resolves with no human
	// move and reports `result: loss` with yourNote "timeout" — a loss the
	// player never made, delivered as a normal result they cannot explain.
	// finishMatch cannot clean this up either: its stale-teardown guard only
	// tells a side still in *that* match to go idle, so the orphan's teardown is
	// suppressed and the client keeps a phantom round on screen. Reject instead,
	// so one client is in at most one match.
	if c.match != nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "already in a match")
		return
	}
	if h.active.Load() >= maxMatches {
		h.mu.Unlock()
		h.handlerError(w, http.StatusServiceUnavailable, "too many active matches")
		return
	}
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	// If the player has an open challenge, drop it (they chose CPU mode)
	if ch, ok := h.challenge[c.pid]; ok {
		delete(h.challenge, c.pid)
		if ch.token != "" {
			delete(h.challenges, ch.token)
		}
	}
	m := h.makeMatch(newID(4), target, side{client: c}, side{bot: true, character: opponent})
	// The engine's default is the 1-off inference; the wire has spoken, so the
	// floor's rule is the request's. Set before startMatchLocked, so it lands
	// before the match's own goroutine reads it.
	m.drawEnds = drawEnds
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
		// Which commit is actually running. The probe suite is pointed at a
		// deployed origin, so without this a green result cannot be
		// distinguished from a stale binary still serving traffic.
		"build": identifyBuild(),
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
	// The clock is sampled once, here, and that single reading is both the
	// late-bound check below and the arrival stamp on the move. Sampling it
	// twice is what let a pick submitted in the final sliver of the window pass
	// the check and then be stamped past the deadline, where drainPending counts
	// it as an on-time tap. resolve judges both ends of the window against the
	// stamp, so this check is the fast path rather than the only guard.
	//
	// The phase/deadline check still races the run loop: the deadline may fire
	// between it and the buffered send, or the match may resolve. Either way the
	// accepted move is never silently corrupted: drainPending counts anything
	// buffered before the deadline fired, and a move that lands after the run
	// loop captured its snapshot is just drained at finishMatch (it can only
	// lose a round that had already effectively closed).
	m := c.match
	h.mu.Unlock()
	if m == nil {
		h.handlerError(w, http.StatusBadRequest, "no active match")
		return
	}
	now := time.Now()
	switch phase := m.phase.Load(); phase {
	case phaseCountdown:
		h.handlerError(w, http.StatusBadRequest, "too early")
		return
	case phaseDone, phaseIdle:
		h.handlerError(w, http.StatusBadRequest, "match over")
		return
	case phaseShoot:
		if now.After(m.deadline()) {
			h.handlerError(w, http.StatusBadRequest, "too late")
			return
		}
	}
	msg := moveMsg{move: move, arrive: now}
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
func (h *Hub) handleChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID           string
		RoundsTarget int
		DrawEnds     *bool
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	// The invite advertises the length the creator picked, so the reservation
	// carries it and /join pairs at it. Decoded exactly as /queue decodes it:
	// a target nobody could ask the queue for would be a series the lobby never
	// described, and absent means one round with drawEnds=true, today's
	// hardwired reservation.
	target := req.RoundsTarget
	if target == 0 {
		target = 1
	}
	if !validSeriesTarget(target) {
		h.handlerError(w, http.StatusBadRequest, "unsupported roundsTarget")
		return
	}
	drawEnds := target <= 1
	if req.DrawEnds != nil {
		drawEnds = *req.DrawEnds
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	if c.match != nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "already in a match")
		return
	}
	if ch, ok := h.challenge[c.pid]; ok {
		// One open code per player. Re-minting returns the same token, but the
		// length is the player's current choice -- the same "re-posting updates
		// the seat" rule /queue uses -- so a length picked before the code is
		// claimed still reaches the match.
		ch.roundsTarget = target
		ch.drawEnds = drawEnds
		tok := ch.token
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"token":%q}`, tok)
		return
	}
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	if len(h.challenges) >= maxQueue {
		h.mu.Unlock()
		h.handlerError(w, http.StatusServiceUnavailable, "queue full")
		return
	}
	tok := newID(8)
	ch := &challengeEntry{token: tok, creatorPid: c.pid, roundsTarget: target, drawEnds: drawEnds}
	h.challenges[tok] = ch
	h.challenge[c.pid] = ch
	h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"token":%q}`, tok)
}

func (h *Hub) handleJoin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    string
		Token string
	}
	if err := h.decode(w, r, &req); err != nil {
		return
	}
	c := h.client(req.ID)
	if c == nil {
		h.handlerError(w, http.StatusBadRequest, "not connected")
		return
	}
	h.mu.Lock()
	if c.match != nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "already in a match")
		return
	}
	ch, ok := h.challenges[req.Token]
	if !ok || ch == nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusNotFound, "challenge gone")
		return
	}
	// A token whose match is live is "in play" whatever the owner's connections
	// are doing: it is consumed at match end, not here, so a second opener must
	// be told that rather than told the link is gone.
	if ch.match != nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "challenge in play")
		return
	}
	// The reservation belongs to the player, so the creator is whichever of the
	// player's connections is live right now -- a reloaded tab or a backgrounded
	// phone that has reconnected is the same creator. No live connection means
	// there is nobody to play against: the join is refused, but the reservation
	// is *not* consumed, so it is claimable again once the creator returns.
	creator := h.creatorClientLocked(ch.creatorPid)
	if creator == nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusNotFound, "challenge gone")
		return
	}
	if creator.match != nil {
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "challenge in play")
		return
	}
	if c.pid == ch.creatorPid {
		// A second connection of the creator's own player is a self-join: the
		// reservation is theirs, so pairing them with themselves is refused. The
		// connection-id guard missed this because each tab is its own client.
		h.mu.Unlock()
		h.handlerError(w, http.StatusConflict, "challenge in play")
		return
	}
	// dequeue claimant if queueing
	if c.queueing {
		h.dequeueLocked(c)
		c.queueing = false
	}
	// The match runs at the length the reservation carries, so the invite screen
	// can advertise what the creator picked. The entry always holds a valid
	// target (handleChallenge normalizes absent to one round).
	m := h.makeMatch(newID(4), ch.roundsTarget, side{client: creator}, side{client: c})
	m.drawEnds = ch.drawEnds
	// The token is consumed when the *match* ends, not here. A second opener
	// while the match is live must be told it is in play (409), and only a join
	// after termination finds the token gone (404). finishMatch is the one hook:
	// every termination reaches it through m.finish, and it drops the entry whose
	// match is this one. ch.match records the pairing so that lookup can find it.
	ch.match = m
	// A challenge survivor goes to the lobby, not the global queue. The link
	// named the opponent, so a cancelled handshake has nobody to pair with; this
	// is the same branch a CPU match takes.
	m.requeue = func(int) bool { return false }
	h.startMatchLocked(m)
	h.mu.Unlock()
	w.Write([]byte("{}"))
}
