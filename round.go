package main

import (
	"math/rand/v2"
	"sync"
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

// readyLease is how stale a readiness ack may be and still count towards opening
// the gate. It must stay comfortably longer than the client's re-ack interval
// (2s, see armReadyLoop in web/app.js) or a well-behaved client would expire its
// own lease between acks and stall the match it is behaving correctly in. A
// package var so tests can shorten it.
var readyLease = 4 * time.Second

// readyRecheck is how often waitReady re-tests freshness. It is only load-bearing
// for a renewal -- the first ack from each side wakes waitReady immediately via
// readyCh -- so this is a polling interval for the stale case and can afford to
// be coarse.
var readyRecheck = 250 * time.Millisecond

// seriesBreak is the pause between one round of a series and the next. It exists
// so the client is still showing the round it just finished -- the result panel,
// the moves, the scoreboard -- before the next countdown starts repainting over
// it. A package var so tests do not have to wait it out.
var seriesBreak = 3 * time.Second

// seriesTarget is the number of decisive round wins that ends a series. Named
// rather than a literal in newMatch so the engine, its tests and the protocol
// docs all quote one number.
const seriesTarget = 3

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
	// phasePreparing covers the span between "a match exists" and "the countdown
	// is announced": the round's background is chosen, `matched` has gone out,
	// the client is loading assets for the match screen, and the readiness gate
	// is waiting on every human side. It exists because that span used to be
	// called phaseCountdown, which meant a phase named after something that had
	// not started yet -- the countdown frames are only emitted on the far side of
	// this phase, once every client has its screen up and has acked.
	phasePreparing
	phaseCountdown
	phaseShoot
	phaseDone
)

func phaseLabel(v int32) string {
	switch v {
	case phasePreparing:
		// This string is on the wire -- the reconnect snapshot's `phase` -- and it
		// changed from "countdown" to "preparing", which a tab open across the
		// deploy would not recognise. That break is deliberate and recorded in
		// docs/features/protocol.md: the honest name is worth more than
		// compatibility with clients that do not exist.
		return "preparing"
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
//	          idle   preparing  countdown   shoot
//	preparing  start()
//	countdown          run() after the gate opens
//	shoot                       run()
//	done            abort()     abort(),        run() after resolve
//	                             readyTimeout(),
//	                             finish()
//	done -> countdown is the series loop: a resolved-but-not-final round walks
//	back to the countdown for the next one. It is the only edge out of done, so a
//	stale goroutine holding a match that has already finished cannot restart a
//	round -- done is terminal for every other path (finishMatch advances into it,
//	but only to stop there).
func allowedPhaseEdge(from, to int32) bool {
	switch from {
	case phaseIdle:
		return to == phasePreparing
	case phasePreparing:
		return to == phaseCountdown || to == phaseDone
	case phaseCountdown:
		return to == phaseShoot || to == phaseDone
	case phaseShoot:
		return to == phaseDone
	case phaseDone:
		return to == phaseCountdown
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
	// background is the stage name chosen for this match. One value for the whole
	// match, not one per side: both players are meant to be looking at the same
	// arena, and a per-side choice would make the two screens disagree for reasons
	// neither player could see. Set by the hub, which owns the roster -- the engine
	// only carries the value and announces it.
	background string
	phase      atomic.Int32

	// Series state: a match that plays more than one round. A CPU match is a
	// series; a PvP match still ends on its first round, which is the CPU-first
	// half of docs/tasks/open/game-mode-architecture.md -- the PvP half re-opens
	// the ready handshake per round, and until it does, honouring a series there
	// would park two players in a match neither can leave.
	//
	// roundsTarget is the number of decisive round wins that ends the series, win
	// the tally so far (a round lost on a `void` timeout is not decisive for the
	// side that caused it, per connectivity-safe scoring), round the 1-based
	// round number, and seriesOver whether the last result ended the match.
	// Written and read on run's own goroutine, so plain ints: see the abandon
	// field for why these are not atomics.
	roundsTarget int
	round        int
	win          [2]int
	seriesOver   bool

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

	// readyAt is when side i last acknowledged readiness, or the zero time if it
	// never has; readySignalled records that readyCh has been closed.
	//
	// Guarded by readyMu rather than packed into an atomic int64 because the
	// lease is a duration measured against time.Now(), and a time.Time carrying a
	// monotonic reading cannot be flattened to an integer without throwing that
	// reading away -- a wall-only stamp would re-interpret a phone's clock step
	// as the ack having gone stale, which is the same class of bug the round
	// deadline documents above.
	readyAt        [2]time.Time
	readySignalled bool
	readyMu        sync.Mutex
	readyCh        chan struct{}

	// now is the match's clock, injectable so the readiness lease can be tested
	// by advancing it rather than by sleeping. Never nil after newMatch.
	now func() time.Time

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
	return &match{
		id:           id,
		readyCh:      make(chan struct{}),
		now:          time.Now,
		roundsTarget: seriesTarget,
		round:        1,
	}
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

// ackReady records that side i is ready to receive the countdown, and refreshes
// the lease on every call rather than only the first -- a repeat ack is the
// lease being renewed, so an implementation that short-circuited on a side that
// had already acked would expire the lease for the one client doing exactly the
// right thing. A bot side is ignored: it has no client to be told anything, so it
// can never be a participant in the gate.
func (m *match) ackReady(i int) {
	if m.sides[i].bot {
		return
	}
	m.readyMu.Lock()
	now := m.clock()
	m.readyAt[i] = now
	all := m.allHumanFreshLocked(now)
	// The nil check is not defensive noise: a match built as a struct literal
	// has no channel to close, and closing nil panics. Nothing waits on readyCh
	// for such a match, so skipping the close is correct rather than a
	// workaround.
	if all && !m.readySignalled && m.readyCh != nil {
		m.readySignalled = true
		close(m.readyCh)
	}
	m.readyMu.Unlock()
}

// allHumanReady reports whether every human side holds a readiness ack that is
// still inside the lease. An all-bot match has no human sides to be fresh and is
// trivially ready.
func (m *match) allHumanReady() bool {
	m.readyMu.Lock()
	defer m.readyMu.Unlock()
	return m.allHumanFreshLocked(m.clock())
}

// clock is the match's time source, falling back to time.Now for a match built as
// a struct literal rather than through newMatch. Without the fallback, a nil now
// takes out every caller of allHumanReady -- including snapshot, which is on the
// reconnect path -- and a zero-value match is easy to write by accident.
func (m *match) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// allHumanFreshLocked is allHumanReady with readyMu already held.
func (m *match) allHumanFreshLocked(now time.Time) bool {
	cutoff := now.Add(-readyLease)
	for i := range m.sides {
		if m.sides[i].bot {
			continue
		}
		if m.readyAt[i].IsZero() || m.readyAt[i].Before(cutoff) {
			return false
		}
	}
	return true
}

// waitReady blocks until the countdown may begin. Every match gates on it, CPU
// included: the client acks once it has finished setting the round up, so the
// countdown cannot begin until it is ready to receive one. That is a
// self-timing buffer rather than a fixed sleep, so a slow client waits as long
// as it needs (up to readyTimeout) and a fast one pays nothing.
//
// It waits on freshness rather than on a one-shot bit. A bit says a side acked
// once, which is true forever; the lease says a side is acking *now*, which is
// the only version of the claim that means anything when the countdown actually
// starts. The re-check tick matters because acks can go stale after every side
// has acked once, which is precisely the side that acked and then vanished.
// Returns false when the pending match should be abandoned (timeout /
// disconnect).
func (m *match) waitReady() bool {
	deadline := time.NewTimer(readyTimeout)
	defer deadline.Stop()
	recheck := time.NewTicker(readyRecheck)
	defer recheck.Stop()
	// readyCh is closed the first time every human side has acked. Taking from a
	// closed channel never blocks, so it has to be nil'd out after the first
	// receive or this loop spins.
	ch := m.readyCh
	for {
		if m.allHumanReady() {
			return true
		}
		select {
		case <-ch:
			ch = nil
		case <-recheck.C:
		case <-deadline.C:
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
}

// readyTimeout cancels a match whose human sides never acked and re-queues
// them; in a CPU match only the human is re-queued.
func (m *match) readyTimeout() {
	m.abandon = abandonTimeout
	m.advance(phasePreparing, phaseDone)
	m.requeueSide(0)
	m.requeueSide(1)
}

// readyAbandon cancels a pending match when side i left before the countdown;
// the survivor is re-queued rather than awarded any result.
func (m *match) readyAbandon(i int) {
	m.abandon = abandonOpponentLeft
	m.abandonSide = i
	m.advance(phasePreparing, phaseDone)
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
	m.advance(phaseIdle, phasePreparing)
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
		data := map[string]any{
			"opponentName":      m.opponentName(i),
			"opponentCharacter": m.opponentCharacter(i),
			"background":        m.background,
			"ts":                tsNow(),
		}
		// With the target, so the client can put an empty scoreboard up for the
		// match it has just been given rather than waiting for round one's result
		// to tell it how long the row it will keep updating is.
		m.seriesFields(data)
		m.send(i, evt("matched", data))
	}

	if !m.waitReady() {
		return
	}
	// Every human has its match screen up and has acked, so the countdown is
	// about to be real. This is the boundary the phase exists to mark: before it
	// the client was loading assets and waiting, after it the deadline is
	// announced and countdown frames go out.
	m.advance(phasePreparing, phaseCountdown)

	// Rounds play until judge says the match is over. There is no branch here for
	// the single-round case: judge decides that from seriesMatch, so the mode
	// rule lives in one place instead of once per caller.
	//
	// The ready handshake is deliberately *not* repeated per round. Neither side
	// left the match screen to be ready for the next one, so re-opening the gate
	// would add a stall no client can act on -- a client that tried would be
	// acking a screen it is already showing.
	for m.playRound() {
	}
}

// seriesMatch reports whether this match plays more than one round. It is derived
// from the sides rather than carried as a flag: a CPU opponent is the whole of
// the current rule, so when the PvP half of the task lands this is the one line
// that changes.
func (m *match) seriesMatch() bool { return m.sides[1].bot }

// seriesFields adds the scoreboard's one shape-changing field to a frame, and
// only to a match that has a series to score. A PvP match is a single round, so
// a target on its frames would promise rounds that never come -- and the client
// reads the target as the width of the pip row it draws, so a "3" there puts a
// three-pip scoreboard over a match that has no score. Absent means "no series",
// which is the reading every client already has for a pre-series server.
func (m *match) seriesFields(data map[string]any) {
	if m.seriesMatch() {
		data["roundsTarget"] = m.roundsTarget
	}
}

// playRound runs one round, from announcing its schedule to emitting its result.
// It returns false when the match cannot continue -- a side left, or the phase
// was lost to a stale transition -- in which case it has already told the client
// what it needed to and the caller must advance nothing.
func (m *match) playRound() bool {
	m.beginRound()

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
		return false
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
			return false
		}
		n := countdownBeats[countdownSlots-i]
		for j := range m.sides {
			m.send(j, evt("countdown", planPayload(n)))
		}
	}
	if m.waitUntil(m.shootAtTime()) {
		m.abort()
		return false
	}
	if m.left() {
		m.abort()
		return false
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
			return false
		case <-m.leftCh(1):
			m.abort()
			return false
		}
	}

	// The round is over, so the phase says so before the picks are judged. A late
	// move arriving after this point is refused by the hub's move handler rather
	// than being judged into a round that has already been reported.
	m.advance(phaseShoot, phaseDone)
	return m.closeRound()
}

// closeRound ends the finished round and reports whether the match continues.
// Judging and discarding stragglers are one step because they are one event: the
// moment the result is reported, anything still buffered belonged to a window
// that has already been reported to both sides.
func (m *match) closeRound() bool {
	cont := m.judge()
	m.discardStragglers()
	return cont
}

// beginRound clears the state that belongs to one round rather than to the
// match, so a round starts from nothing: no deadline and no picks carried over.
func (m *match) beginRound() {
	m.shootAt.Store(nil)
	m.moves[0], m.moves[1] = nil, nil
}

// discardStragglers drops any pick still buffered once a round has been judged.
//
// The shoot loop stops reading when the window closes, so a pick accepted before
// the deadline can still be sitting in the channel when the round is judged, and
// the next round's loop would take it as that round's pick -- judged against a
// deadline its arrival predates, so it would surface as an `early` loss in a
// round the player never saw it belong to. That is the defect
// `drainPending`'s own comment already names and rules out ("a straggler can
// only lose an already-closed round"); in a single-round match the rule was
// free, and in a series it is this call.
//
// It runs after the judgement, not before the round, because the engine does not
// pre-filter what it receives: a pick that arrived *before* its round's window
// opened is judged `early` and loses (see `judgeRound`), and discarding it at
// the start of the round would silently convert that into a timeout `void`.
func (m *match) discardStragglers() {
	for i := range m.sides {
		for {
			if _, ok := m.takeFirst(i); !ok {
				break
			}
		}
	}
}

// judge resolves the round, keeps the series tally, announces the result, and
// reports whether another round is to be played. It returns false when the match
// is over.
//
// The order matters and is the reason this is one function rather than three:
// the result frames must carry the tally *including* this round, and the final
// one must carry seriesOver: true. Deciding either after announcing would tell
// the client a score the server does not hold, and would end the match on a
// frame that claims it is still going.
//
// The tally is read from the judged result rather than recomputed from the moves,
// so the score the client was told and the score the server keeps cannot drift.
// A draw is worth nothing to either side and replays, which is why the series has
// no round cap: two sides that keep drawing never end it, by design rather than
// by omission.
func (m *match) judge() bool {
	res, ps := m.judgeRound()
	for i := range m.sides {
		if res[i] == ResultWin {
			m.win[i]++
		}
	}
	// A non-series match is over the moment its only round is judged, so the same
	// expression covers "first to N" and "one round" without a branch.
	m.seriesOver = !m.seriesMatch() ||
		m.win[0] >= m.roundsTarget || m.win[1] >= m.roundsTarget
	m.announce(res, ps)
	if m.seriesOver {
		return false
	}
	m.round++
	// The client is mid-round-break: it has just been told the outcome and still
	// has the result panel up. This is client pacing, not a safety margin, so it
	// is a var for tests to shrink rather than a rule to tune.
	if m.wait(seriesBreak) {
		return false
	}
	return m.advance(phaseDone, phaseCountdown)
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

// judgeRound scores the round's picks and returns the outcome per side together
// with the per-side detail the result frame reports. It reads m.moves and emits
// nothing: judge announces once the series tally is settled, so the frames can
// carry the score this round produced.
func (m *match) judgeRound() ([2]Result, [2]pickOutcome) {
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
		// Connectivity-safe scoring: a no-valid-move timeout resolves as void
		// for the absent side (never a loss), while the opponent wins the round.
		// late/early cases remain losses as their notes indicate.
		if ps[0].note == "timeout" {
			res = [2]Result{ResultVoid, ResultWin}
		} else {
			res = [2]Result{ResultLoss, ResultWin}
		}
	case !ps[1].valid:
		if ps[1].note == "timeout" {
			res = [2]Result{ResultWin, ResultVoid}
		} else {
			res = [2]Result{ResultLoss, ResultWin}
		}
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

	return res, ps
}

// announce sends each side its result frame, carrying the series state as it
// stands after this round -- which is why judge calls it last.
func (m *match) announce(res [2]Result, ps [2]pickOutcome) {
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
			"round":             m.round,
			"youRoundWins":      m.win[i],
			"oppRoundWins":      m.win[opp],
			"seriesOver":        m.seriesOver,
		}
		m.seriesFields(data)
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
	if !m.advance(phaseShoot, phaseDone) &&
		!m.advance(phaseCountdown, phaseDone) &&
		!m.advance(phasePreparing, phaseDone) {
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
