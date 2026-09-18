package main

import (
	"fmt"
	"math/rand/v2"
	"sync/atomic"
	"time"
)

const (
	countStep   = 2 * time.Second
	shootWindow = 2 * time.Second
)

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
//	done      --         abort()     abort(), endMatch, run() after resolve
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

var stateDebug = false

func (m *match) advance(from, to int32) bool {
	if !allowedPhaseEdge(from, to) {
		if stateDebug {
			fmt.Printf("kxp: illegal phase edge %s -> %s (current %s)\n",
				phaseLabel(from), phaseLabel(to), m.phaseName())
		}
		return false
	}
	if !m.phase.CompareAndSwap(from, to) {
		if stateDebug {
			fmt.Printf("kxp: stale phase transition %s -> %s (current %s)\n",
				phaseLabel(from), phaseLabel(to), m.phaseName())
		}
		return false
	}
	return true
}

type moveMsg struct {
	move   Move
	arrive time.Time
	sawPun int64
	click  int64
}

type side struct {
	client    *Client
	bot       bool
	character string
}

type match struct {
	hub     *Hub
	id      string
	sides   [2]side
	botMove chan moveMsg
	phase   atomic.Int32
	shootAt time.Time
	moves   [2]*moveMsg
}

func (h *Hub) makeMatch(id string, s0, s1 side) *match {
	m := &match{hub: h, id: id, sides: [2]side{s0, s1}}
	if s1.bot {
		m.botMove = make(chan moveMsg, 1)
	}
	return m
}

func (m *match) start() {
	for _, s := range m.sides {
		if s.client != nil {
			s.client.match = m
			s.client.drainMoves()
		}
	}
	m.advance(phaseIdle, phaseCountdown)
	go m.run()
}

func (m *match) run() {
	defer m.hub.endMatch(m)

	if m.left() {
		m.abort()
		return
	}

	for i := range m.sides {
		m.send(i, evt("matched", map[string]any{
			"opponentName":      m.opponentName(i),
			"opponentCharacter": m.opponentCharacter(i),
		}))
	}

	for _, w := range []string{"KA", "CHI"} {
		for i := range m.sides {
			m.send(i, evt("countdown", map[string]any{"n": w}))
		}
		if m.wait(countStep) {
			m.abort()
			return
		}
	}

	if m.left() {
		m.abort()
		return
	}

	m.advance(phaseCountdown, phaseShoot)
	m.shootAt = time.Now()
	for i := range m.sides {
		m.send(i, evt("shoot", map[string]any{"windowMs": shootWindow.Milliseconds()}))
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
	return m.sides[i].client.moves
}

func (m *match) leftCh(i int) <-chan struct{} {
	s := m.sides[i]
	if s.client == nil {
		return nil
	}
	return s.client.alive.Done()
}

func (m *match) left() bool {
	for _, s := range m.sides {
		if s.client != nil && s.client.alive.Err() != nil {
			return true
		}
	}
	return false
}

func (m *match) send(i int, ev sseEv) {
	if s := m.sides[i]; s.client != nil {
		s.client.sendEv(ev)
	}
}

func (m *match) opponentName(i int) string {
	if m.sides[1-i].bot {
		return "CPU"
	}
	return "Opponent"
}

func (m *match) sideCharacter(i int) string {
	s := m.sides[i]
	if s.bot {
		return s.character
	}
	if s.client == nil {
		return defaultCharacterID()
	}
	m.hub.mu.Lock()
	defer m.hub.mu.Unlock()
	return s.client.character
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
		ps[i].timing = msg.arrive.Sub(m.shootAt)
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
	if msg.sawPun <= 0 || msg.click <= 0 || msg.click < msg.sawPun {
		return nil
	}
	ms := msg.click - msg.sawPun
	return &ms
}

func (m *match) abort() {
	if !m.advance(phaseShoot, phaseDone) && !m.advance(phaseCountdown, phaseDone) {
		return
	}
	for i, s := range m.sides {
		if s.client == nil || s.client.alive.Err() == nil {
			continue
		}
		other := m.sides[1-i]
		if other.client != nil && other.client.alive.Err() == nil {
			other.client.sendEv(evt("opponent-left", map[string]any{"outcome": ResultWin, "mode": "online"}))
		}
	}
}

func (m *match) phaseName() string {
	return phaseLabel(m.phase.Load())
}
