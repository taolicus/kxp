package main

import (
	"testing"
	"time"
)

func TestStartDrainsLeftoverMoves(t *testing.T) {
	h := NewHub()
	a := newClient()
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	m := h.makeMatch("ml1", side{client: a}, side{bot: true, character: "smoke"})

	m.start()

	select {
	case msg := <-a.moves:
		t.Errorf("start() left stale move in channel: %+v", msg)
	default:
	}

	a.cancel()
}

func TestFinishDrainsLeftoverMoves(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("ml2", side{client: a}, side{client: b})
	a.match = m
	b.match = m
	a.moves <- moveMsg{move: MovePaper, arrive: time.Now()}
	b.moves <- moveMsg{move: MoveScissors, arrive: time.Now()}

	m.finish()

	if a.match != nil || b.match != nil {
		t.Error("finish() left client.match set")
	}
	for i, c := range []*Client{a, b} {
		select {
		case msg := <-c.moves:
			t.Errorf("finish() left stale move for client %d: %+v", i, msg)
		default:
		}
	}
}

func TestStartDoesNotEatValidPickDuringShoot(t *testing.T) {
	h := NewHub()
	a := newClient()
	b := newClient()
	m := h.makeMatch("ml3", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitForEvent(t, b, "shoot")
	waitForEvent(t, a, "shoot")
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	b.moves <- moveMsg{move: MovePaper, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["you"] != "rock" || ra["outcome"] != "loss" {
		t.Errorf("a result = %v, want rock/loss", ra)
	}
	rb := waitForEvent(t, b, "result")
	if rb["you"] != "paper" || rb["outcome"] != "win" {
		t.Errorf("b result = %v, want paper/win", rb)
	}
}
