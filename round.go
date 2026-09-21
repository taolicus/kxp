package main

import (
	"math/rand/v2"
	"sync/atomic"
	"time"
)

const (
	countStep   = time.Second
	shootWindow = 2 * time.Second
)

// readyTimeout bounds how long a matched pair may take to both advertise that
// they are ready to receive the countdown. A package var so tests can shrink it.
var readyTimeout = 8 * time.Second

const (
	phaseIdle int32 = iota
	phaseCountdown
	phaseShoot
	phaseDone
)

func phaseLabel(v int32) string {
	switch v {
	case phaseCountdown:
		return "countdown"
	case phaseShoot:
		return "shoot"
	case phaseDone:
		return "done"
	default:
		return "idle"
	}
}

// Allowed match phase transitions. advance returns false when the edge isn't
// legal (see allowedPhaseEdge) or when the current phase isn't "from" (e.g. a
// stale goroutine racing a finished match), so only the first transition wins.
//
//	          idle       countdown   shoot
//	countdown start
//	shoot                run()
//	done      --         abort()     abort(), finish(), run() after resolve
func allowedPhaseEdge(from, to int32) bool {
	switch from {
	case phaseIdle:
		return to == phaseCountdown
	case phaseCountdown:
		return to == phaseShoot || to == phaseDone
	case phaseShoot:
		return to == phaseDone
	default:
		return false
	}
}

func (m *match) advance(from, to int32) bool {
	if !allowedPhaseEdge(from, to) {
		return false
	}
	if !m.phase.CompareAndSwap(from, to) {
		return false
	}
	return true
}

type moveMsg struct {
	move      Move
	arrive    time.Time
	sawPunAt  int64
	clickedAt int64
}

// event is the neutral push primitive the engine emits; the hub wires it to
// concrete clients (SSE framing in server.go).
type event struct {
	Type string
	Data any
}

func evt(t string, data any) event {
	return event{Type: t, Data: data}
}

// matchParty is everything the engine knows about one side of a match. The hub
// fills these in from concrete clients (see Hub.makeMatch); the engine never
// touches Hub, Client, OR SSE types — only channels, callbacks, and values.
type matchParty struct {
	bot       bool
	name      string
	character string
	emit      func(event)     // nil for bots: delivers one event to this side
	moves     <-chan moveMsg  // nil for bots: incoming move stream
	left      <-chan struct{} // nil for bots: closed once this side leaves
}

type match struct {
	id      string
	sides   [2]matchParty
	botMove chan moveMsg
	phase   atomic.Int32
	shootAt atomic.Int64 // announced PUN deadline (epoch ns); fixed at countdown start
	moves   [2]*moveMsg
	ready   atomic.Int32 // bitmask: bit i set once side i acked readiness
	readyCh chan struct{}

	// requeue re-queues side i after a failed ready handshake. Hub-provided;
	// nil in engine-only tests.
	requeue func(i int)
	// finish runs exactly once when the match is over (hub cleanup). Must be
	// provided for any match that actually runs.
	finish func()
}

func newMatch(id string) *match {
	return &match{id: id, readyCh: make(chan struct{})}
}

// shootAtTime is the announced PUN deadline as a time.Time.
func (m *match) shootAtTime() time.Time { return time.Unix(0, m.shootAt.Load()) }

// shootAtMs is the announced PUN deadline in server epoch-ms, as carried in
// outbound frames.
func (m *match) shootAtMs() int64 { return time.Unix(0, m.shootAt.Load()).UnixMilli() }

// deadline is when the PUN window closes, server-authoritative.
func (m *match) deadline() time.Time { return m.shootAtTime().Add(shootWindow) }

// tsNow stamps an outbound frame with the server clock (epoch-ms). Clients use
// it to separate delivery lag from clock skew.
func tsNow() int64 { return time.Now().UnixMilli() }

// ackReady marks side i as ready to receive the countdown. Idempotent; closes
// readyCh once every human side has acked.
func (m *match) ackReady(i int) {
	const both = int32(3)
	for {
		cur := m.ready.Load()
		if cur&(1<<i) != 0 {
			return
		}
		if !m.ready.CompareAndSwap(cur, cur|(1<<i)) {
			continue
		}
		if cur|(1<<i) == both {
			close(m.readyCh)
		}
		return
	}
}

// needsReady reports whether this match waits for a ready handshake. Only
// two-player (PVP) matches gate on readiness; CPU matches have one human who
// just clicked, so they start immediately.
func (m *match) needsReady() bool {
	return !m.sides[0].bot && !m.sides[1].bot
}

// bothReady reports whether every side has acked readiness.
func (m *match) bothReady() bool {
	return m.ready.Load() == 3
}

// waitReady blocks until the countdown may begin. Returns false when the
// pending match should be abandoned (timeout / disconnect).
func (m *match) waitReady() bool {
	if !m.needsReady() || m.bothReady() {
		return true
	}
	timer := time.NewTimer(readyTimeout)
	defer timer.Stop()
	select {
	case <-m.readyCh:
		return true
	case <-timer.C:
		m.readyTimeout()
		return false
	case <-m.leftCh(0):
		m.readyAbandon(0)
		return false
	case <-m.leftCh(1):
		m.readyAbandon(1)
		return false
	}
}

// readyTimeout cancels a match whose pair never acked and re-queues them.
func (m *match) readyTimeout() {
	m.advance(phaseCountdown, phaseDone)
	m.requeueSide(0)
	m.requeueSide(1)
}

// readyAbandon cancels a pending match when side i left before the countdown;
// the survivor is re-queued rather than awarded any result.
func (m *match) readyAbandon(i int) {
	m.advance(phaseCountdown, phaseDone)
	m.requeueSide(1 - i)
}

func (m *match) requeueSide(i int) {
	if m.requeue != nil {
		m.requeue(i)
	}
}

// start advances idle -> countdown and runs the match concurrently.
func (m *match) start() {
	m.advance(phaseIdle, phaseCountdown)
	go m.run()
}

func (m *match) run() {
	defer func() {
		if m.finish != nil {
			m.finish()
		}
	}()

	if m.left() {
		m.abort()
		return
	}

	for i := range m.sides {
		m.send(i, evt("matched", map[string]any{
			"opponentName":      m.opponentName(i),
			"opponentCharacter": m.opponentCharacter(i),
			"ts":                tsNow(),
		}))
	}

	if !m.waitReady() {
		return
	}

	// Announce the round schedule before the countdown starts: the deadline is
	// fixed here (KA at S-2s, CHI at S-1s, PUN at S) and the loop sleeps to the
	// announced slots. The client plays the countdown against a deadline it
	// already knows, so a stalled or dropped `shoot` frame can no longer cost
	// the round; the shoot frame stays authoritative for the window.
	m.shootAt.Store(time.Now().Add(2 * countStep).UnixNano())

	if m.left() {
		m.abort()
		return
	}

	planPayload := func(n string) map[string]any {
		return map[string]any{
			"n":        n,
			"shootAt":  m.shootAtMs(),
			"windowMs": shootWindow.Milliseconds(),
			"ts":       tsNow(),
		}
	}
	for i := range m.sides {
		m.send(i, evt("countdown", planPayload("KA")))
	}
	if m.waitUntil(m.shootAtTime().Add(-countStep)) {
		m.abort()
		return
	}
	for i := range m.sides {
		m.send(i, evt("countdown", planPayload("CHI")))
	}
	if m.waitUntil(m.shootAtTime()) {
		m.abort()
		return
	}
	if m.left() {
		m.abort()
		return
	}

	m.advance(phaseCountdown, phaseShoot)
	for i := range m.sides {
		m.send(i, evt("shoot", map[string]any{
			"windowMs": shootWindow.Milliseconds(),
			"shootAt":  m.shootAtMs(),
			"ts":       tsNow(),
		}))
	}

	if m.sides[1].bot {
		go m.botAction()
	}

	deadline := time.NewTimer(shootWindow)
	defer deadline.Stop()

loop:
	for m.moves[0] == nil || m.moves[1] == nil {
		select {
		case msg := <-m.moveCh(0):
			if m.moves[0] == nil {
				m.moves[0] = &msg
			}
		case msg := <-m.moveCh(1):
			if m.moves[1] == nil {
				m.moves[1] = &msg
			}
		case <-deadline.C:
			m.drainPending()
			break loop
		case <-m.leftCh(0):
			m.abort()
			return
		case <-m.leftCh(1):
			m.abort()
			return
		}
	}

	m.resolve()
	m.advance(phaseShoot, phaseDone)
}

func (m *match) wait(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return m.left()
	case <-m.leftCh(0):
		return true
	case <-m.leftCh(1):
		return true
	}
}

// waitUntil sleeps until an announced schedule slot (t), aborting on a side
// leaving. Returns true when the match should abort. Nobody sleeps when the
// slot already passed — the announced deadline stays authoritative.
func (m *match) waitUntil(t time.Time) bool {
	if d := time.Until(t); d > 0 {
		return m.wait(d)
	}
	return m.left()
}

func (m *match) botAction() {
	delay := time.Duration(50+rand.IntN(300)) * time.Millisecond
	select {
	case <-time.After(delay):
	case <-m.leftCh(0):
		return
	}
	select {
	case m.botMove <- moveMsg{move: randomMove(), arrive: time.Now()}:
	default:
	}
}

func (m *match) moveCh(i int) <-chan moveMsg {
	if m.sides[i].bot {
		return m.botMove
	}
	return m.sides[i].moves
}

// takeFirst returns the first move pending on side i's channel without
// blocking; ok is false when the channel is empty.
func (m *match) takeFirst(i int) (msg moveMsg, ok bool) {
	select {
	case msg = <-m.moveCh(i):
		return msg, true
	default:
		return moveMsg{}, false
	}
}

// drainPending counts any move accepted into a side's channel before the
// deadline fired, so an on-time tap is never dropped by a scheduler coin-flip
// between the moves channel and the deadline timer.
func (m *match) drainPending() {
	for i := 0; i < 2; i++ {
		if m.moves[i] == nil {
			if msg, ok := m.takeFirst(i); ok {
				m.moves[i] = &msg
			}
		}
	}
}

func (m *match) leftCh(i int) <-chan struct{} {
	return m.sides[i].left
}

func (m *match) left() bool {
	for i := range m.sides {
		if ch := m.sides[i].left; ch != nil && isClosed(ch) {
			return true
		}
	}
	return false
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func (m *match) send(i int, ev event) {
	if s := m.sides[i]; s.emit != nil {
		s.emit(ev)
	}
}

// indexOfMoves returns the side whose move stream is ch, or -1. Used by the
// hub to map a concrete client back to a party (snapshot, ready ack).
func (m *match) indexOfMoves(ch <-chan moveMsg) int {
	for i := range m.sides {
		if !m.sides[i].bot && m.sides[i].moves == ch {
			return i
		}
	}
	return -1
}

func (m *match) opponentName(i int) string {
	return m.sides[1-i].name
}

func (m *match) sideCharacter(i int) string {
	return m.sides[i].character
}

func (m *match) opponentCharacter(i int) string {
	return m.sideCharacter(1 - i)
}

type pickOutcome struct {
	move     Move
	timing   time.Duration
	valid    bool
	note     string
	clientMs *int64
}

func (m *match) resolve() {
	var ps [2]pickOutcome
	for i := 0; i < 2; i++ {
		msg := m.moves[i]
		if msg == nil {
			ps[i].note = "timeout"
			continue
		}
		ps[i].move = msg.move
		ps[i].timing = msg.arrive.Sub(m.shootAtTime())
		ps[i].valid = ps[i].timing >= 0
		ps[i].clientMs = clientReactionMs(msg)
		if !ps[i].valid {
			ps[i].note = "early"
		}
	}

	var res [2]Result
	switch {
	case !ps[0].valid && !ps[1].valid:
		res = [2]Result{ResultDraw, ResultDraw}
	case !ps[0].valid:
		res = [2]Result{ResultLoss, ResultWin}
	case !ps[1].valid:
		res = [2]Result{ResultWin, ResultLoss}
	default:
		r := EvaluateRound(ps[0].move, ps[1].move)
		switch r {
		case ResultDraw:
			res = [2]Result{ResultDraw, ResultDraw}
		case ResultWin:
			res = [2]Result{ResultWin, ResultLoss}
		default:
			res = [2]Result{ResultLoss, ResultWin}
		}
	}

	for i := range m.sides {
		opp := 1 - i
		mode := "online"
		if m.sides[opp].bot {
			mode = "cpu"
		}
		data := map[string]any{
			"you":               string(ps[i].move),
			"youTimingMs":       timingMs(ps[i]),
			"youClientMs":       ps[i].clientMs,
			"yourNote":          ps[i].note,
			"youCharacter":      m.sideCharacter(i),
			"opponent":          string(ps[opp].move),
			"opponentTimingMs":  timingMs(ps[opp]),
			"opponentClientMs":  ps[opp].clientMs,
			"opponentNote":      ps[opp].note,
			"opponentCharacter": m.sideCharacter(opp),
			"outcome":           string(res[i]),
			"opponentName":      m.opponentName(i),
			"mode":              mode,
			"ts":                tsNow(),
		}
		m.send(i, evt("result", data))
	}
}

func timingMs(p pickOutcome) *int64 {
	if !p.valid || p.note == "timeout" {
		return nil
	}
	ms := p.timing.Milliseconds()
	return &ms
}

func clientReactionMs(msg *moveMsg) *int64 {
	if msg.sawPunAt <= 0 || msg.clickedAt <= 0 || msg.clickedAt < msg.sawPunAt {
		return nil
	}
	ms := msg.clickedAt - msg.sawPunAt
	return &ms
}

func (m *match) abort() {
	if !m.advance(phaseShoot, phaseDone) && !m.advance(phaseCountdown, phaseDone) {
		return
	}
	for i := range m.sides {
		side := m.sides[i]
		if side.emit == nil {
			continue
		}
		if side.left != nil && !isClosed(side.left) {
			continue
		}
		other := m.sides[1-i]
		if other.emit != nil && (other.left == nil || !isClosed(other.left)) {
			m.send(1-i, evt("opponent-left", map[string]any{"outcome": ResultWin, "mode": "online"}))
		}
	}
}

func (m *match) phaseName() string {
	return phaseLabel(m.phase.Load())
}
