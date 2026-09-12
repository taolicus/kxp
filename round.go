package main

import (
	"math/rand/v2"
	"sync/atomic"
	"time"
)

const (
	countStep   = time.Second
	shootWindow = 1200 * time.Millisecond
)

const (
	phaseIdle int32 = iota
	phaseCountdown
	phaseShoot
	phaseDone
)

type moveMsg struct {
	move   Move
	arrive time.Time
}

type side struct {
	client *Client
	bot    bool
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
		}
	}
	m.phase.Store(phaseCountdown)
	go m.run()
}

func (m *match) run() {
	defer m.hub.endMatch(m)

	if m.left() {
		m.abort()
		return
	}

	for i := range m.sides {
		m.send(i, evt("matched", map[string]any{"opponentName": m.opponentName(i)}))
	}

	for _, n := range []int{3, 2, 1} {
		if m.wait(countStep) {
			m.abort()
			return
		}
		for i := range m.sides {
			m.send(i, evt("countdown", map[string]any{"n": n}))
		}
	}

	if m.left() {
		m.abort()
		return
	}

	m.phase.Store(phaseShoot)
	m.shootAt = time.Now()
	for i := range m.sides {
		m.send(i, evt("shoot", map[string]any{}))
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
	m.phase.Store(phaseDone)
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

type pickOutcome struct {
	move   Move
	timing time.Duration
	valid  bool
	note   string
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
		data := map[string]any{
			"you":              string(ps[i].move),
			"youTimingMs":      timingMs(ps[i]),
			"yourNote":         ps[i].note,
			"opponent":         string(ps[opp].move),
			"opponentTimingMs": timingMs(ps[opp]),
			"opponentNote":     ps[opp].note,
			"outcome":          string(res[i]),
			"opponentName":     m.opponentName(i),
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

func (m *match) abort() {
	m.phase.Store(phaseDone)
	for i, s := range m.sides {
		if s.client == nil || s.client.alive.Err() == nil {
			continue
		}
		other := m.sides[1-i]
		if other.client != nil && other.client.alive.Err() == nil {
			other.client.sendEv(evt("opponent-left", map[string]any{"outcome": ResultWin}))
		}
	}
}

func (m *match) phaseName() string {
	switch m.phase.Load() {
	case phaseCountdown:
		return "countdown"
	case phaseShoot:
		return "shoot"
	default:
		return "idle"
	}
}
