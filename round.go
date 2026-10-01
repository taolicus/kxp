package main

import (
	"math/rand/v2"
	"sync/atomic"
	"time"
)

const (
	countStep   = time.Second
	shootWindow = 2 * time.Second

	// countdownSlots is how many beats precede PUN, and is what the announced
	// deadline is offset by: a three-beat countdown announces PUN three steps
	// out, so READY lands the moment the gate opens and KA/CHI follow one step
	// apart. countdownBeats is sized from it, so the two cannot drift. The
	// leading READY beat is slack for delivery lag; the last two are the
	// KA-CHI-PUN rhythm itself. Keep this in step with COUNTDOWN_SLOTS in
	// web/kxp.js -- the client paints from the deadline using that table, and a
	// mismatch would show the wrong beat.
	countdownSlots = 3
)

// countdownBeats are the beats announced before PUN, in the order they run.
var countdownBeats = [countdownSlots]string{"READY", "KA", "CHI"}

// readyTimeout bounds how long a match may wait for every human side to
// advertise that it is ready to receive the countdown. A package var so tests
// can shrink it.
var readyTimeout = 8 * time.Second

// Why a pending match was cancelled before its countdown began. Reported to the
// client on the teardown frame so a bounced player learns the round was
// *cancelled* rather than lost — silence here is what made a slow link look
// like a mystery.
const (
	abandonNone int32 = iota
	abandonTimeout
	abandonOpponentLeft
)

func abandonLabel(v int32) string {
	switch v {
	case abandonTimeout:
		return "handshake-timeout"
	case abandonOpponentLeft:
		return "opponent-left"
	default:
		return ""
	}
}

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
	// shootAt is the announced PUN deadline, fixed at countdown start. It is
	// held as a time.Time rather than epoch-ns so it carries a monotonic
	// reading alongside the wall clock, because three separate judgements are
	// made against it within a round: arrival timing in resolve, the KA/CHI/PUN
	// sleeps in run, and the too-late cutoff in handleMove. Each compares it
	// against a time.Now() that *does* carry a monotonic reading, and
	// time.Time.Sub silently falls back to wall arithmetic when either operand
	// lacks one — so a wall-only deadline makes all three wrong by exactly the
	// size of any clock step in the interval. A phone that changes network or
	// resyncs NTP steps the wall clock mid-round; the wire value is derived from
	// the same instant (see shootAtMs), so the protocol is unaffected.
	shootAt atomic.Pointer[time.Time]
	moves   [2]*moveMsg
	ready   atomic.Int32 // bitmask: bit i set once side i acked readiness
	readyCh chan struct{}

	// requeue re-queues side i after a failed ready handshake. Hub-provided;
	// nil in engine-only tests. Returns whether side i actually went back on
	// the queue, which is false for a CPU match's human (it returns to the
	// lobby instead of joining the online queue) and for a side with no
	// connection.
	requeue func(i int) bool
	// finish runs exactly once when the match is over (hub cleanup). Must be
	// provided for any match that actually runs.
	finish func()

	// abandon records why the handshake was cancelled (abandonNone for a match
	// that ran). A plain int32 rather than an atomic: it is written in
	// readyTimeout/readyAbandon and read in finish, which is deferred in run on
	// the same goroutine, so the accesses are already ordered. Every other field
	// here is atomic because it is genuinely shared across goroutines; this one
	// is not, and an atomic would imply a guarantee that isn't needed.
	abandon int32
	// abandonSide is the side that left, for abandonOpponentLeft only.
	abandonSide int
	// requeued records, per side, whether that side went back on the online
	// queue when the handshake failed. Written by requeueSide and read by the
	// hub's teardown, so same ordering argument as abandon.
	requeued [2]bool
}

func newMatch(id string) *match {
	return &match{id: id, readyCh: make(chan struct{})}
}

// setShootAt fixes the announced PUN deadline. The caller must pass a value
// derived from time.Now() so the monotonic reading is retained; storing a
// reconstructed wall time here (time.Unix, a parsed frame, a zero Time) would
// reintroduce the wall-clock dependence this exists to remove.
func (m *match) setShootAt(at time.Time) { m.shootAt.Store(&at) }

// shootAtTime is the announced PUN deadline, or the zero time if the round
// schedule has not been announced yet.
func (m *match) shootAtTime() time.Time {
	if p := m.shootAt.Load(); p != nil {
		return *p
	}
	return time.Time{}
}

// hasShootAt reports whether the round schedule has been announced.
func (m *match) hasShootAt() bool { return m.shootAt.Load() != nil }

// shootAtMs is the announced deadline in server epoch-ms, as carried in
// outbound frames. Wall clock deliberately: the client reconciles it against its
// own clock and its skew estimate, so the wire value must stay a wall instant.
func (m *match) shootAtMs() int64 { return m.shootAtTime().UnixMilli() }

// deadline is when the PUN window closes, server-authoritative.
func (m *match) deadline() time.Time { return m.shootAtTime().Add(shootWindow) }

// tsNow stamps an outbound frame with the server clock (epoch-ms). Clients use
// it to separate delivery lag from clock skew.
func tsNow() int64 { return time.Now().UnixMilli() }

// humanMask is the set of sides that must ack readiness: every non-bot. A CPU
// match has one human, so its mask is 0b01 rather than the PVP 0b11.
func (m *match) humanMask() int32 {
	var mask int32
	for i := range m.sides {
		if !m.sides[i].bot {
			mask |= 1 << i
		}
	}
	return mask
}

// ackReady marks side i as ready to receive the countdown. Idempotent; closes
// readyCh once every human side has acked. A bot side is ignored: it has no
// client to be told anything, so it can never be a participant in the gate.
func (m *match) ackReady(i int) {
	if m.sides[i].bot {
		return
	}
	mask := m.humanMask()
	for {
		cur := m.ready.Load()
		if cur&(1<<i) != 0 {
			return
		}
		if !m.ready.CompareAndSwap(cur, cur|(1<<i)) {
			continue
		}
		if (cur|(1<<i))&mask == mask {
			close(m.readyCh)
		}
		return
	}
}

// allHumanReady reports whether every human side has acked readiness. An
// all-bot match has an empty mask and is trivially ready.
func (m *match) allHumanReady() bool {
	mask := m.humanMask()
	return m.ready.Load()&mask == mask
}

// waitReady blocks until the countdown may begin. Every match gates on it, CPU
// included: the client acks from the end of its `matched` handler, so the
// countdown cannot begin until it has actually finished setting the match up.
// That is a self-timing buffer rather than a fixed sleep, so a slow client
// waits as long as it needs (up to readyTimeout) and a fast one pays nothing.
// Returns false when the pending match should be abandoned (timeout /
// disconnect).
func (m *match) waitReady() bool {
	if m.allHumanReady() {
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

// readyTimeout cancels a match whose human sides never acked and re-queues
// them; in a CPU match only the human is re-queued.
func (m *match) readyTimeout() {
	m.abandon = abandonTimeout
	m.advance(phaseCountdown, phaseDone)
	m.requeueSide(0)
	m.requeueSide(1)
}

// readyAbandon cancels a pending match when side i left before the countdown;
// the survivor is re-queued rather than awarded any result.
func (m *match) readyAbandon(i int) {
	m.abandon = abandonOpponentLeft
	m.abandonSide = i
	m.advance(phaseCountdown, phaseDone)
	m.requeueSide(1 - i)
}

// requeueSide offers side i back to the hub's queue and records whether it
// actually went, so the teardown frame can tell the client where that side
// ended up. A CPU match's human is offered and declined (it returns to the
// lobby), which is exactly the distinction the client needs to render.
func (m *match) requeueSide(i int) {
	if m.requeue != nil {
		m.requeued[i] = m.requeue(i)
	}
}

// abandonReason reports why the pending match was cancelled, or "" if it was
// not cancelled. Read by the hub during teardown; see the abandon field for why
// this needs no synchronisation.
func (m *match) abandonReason() string { return abandonLabel(m.abandon) }

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
	// fixed here and the loop sleeps to the announced slots. The client plays
	// the countdown against a deadline it already knows, so a stalled or dropped
	// `shoot` frame can no longer cost the round; the shoot frame stays
	// authoritative for the window.
	//
	// The lead is countdownSlots long rather than the two beats KA/CHI alone
	// need. The countdown frames are the client's first warning that a round is
	// starting, and they arrive over the same connection that has to survive
	// radio wake-up, a flaky AP or a buffering proxy. Announcing only two beats
	// meant a link that lost ~2s of delivery painted no countdown at all: the
	// player saw the count jump to PUN and had no cue the round had begun, even
	// though the pick window was still open. A leading READY beat buys a second
	// of slack for that, and the client degrades to whichever beats remain
	// rather than skipping the countdown (see countdownSlot in web/kxp.js).
	m.setShootAt(time.Now().Add(countdownSlots * countStep))

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
	// Walk the slots in reverse: countdownSlots is how many beats precede PUN,
	// and the last beat is the one due one step out.
	for i := countdownSlots; i > 0; i-- {
		if m.waitUntil(m.shootAtTime().Add(-time.Duration(i) * countStep)) {
			m.abort()
			return
		}
		n := countdownBeats[countdownSlots-i]
		for j := range m.sides {
			m.send(j, evt("countdown", planPayload(n)))
		}
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
		ps[i].clientMs = clientReactionMs(msg)
		// Both ends of the announced window are authoritative, not just the near
		// one: a pick counts only if it landed inside [shootAt, deadline].
		// handleMove's late check is explicitly best-effort — it reads the clock
		// before stamping the arrival — so a pick submitted in the final sliver of
		// the window can pass that check and be stamped past the deadline, where
		// drainPending counts it as an on-time tap. Judging `>= shootAt` alone let
		// such a pick win a round on a move the server would have rejected with
		// `400 too late` a moment later.
		//
		// `late` is deliberately not `timeout`: connectivity-safe scoring keys a
		// no-contest on `timeout`, and a late pick is a deliberate act — like an
		// early one — that stays a full loss rather than becoming a draw.
		switch {
		case msg.arrive.Before(m.shootAtTime()):
			ps[i].note = "early"
		case msg.arrive.After(m.deadline()):
			ps[i].note = "late"
		default:
			ps[i].valid = true
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
