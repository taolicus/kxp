package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func parseChunk(t *testing.T, b []byte) (string, map[string]any) {
	t.Helper()
	typ := ""
	var data map[string]any
	for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if strings.HasPrefix(line, "event: ") {
			typ = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data); err != nil {
				t.Fatalf("bad event data: %v", err)
			}
		}
	}
	return typ, data
}

func nextEvent(t *testing.T, c *Client) (string, map[string]any) {
	t.Helper()
	select {
	case b := <-c.send:
		return parseChunk(t, b)
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for an event")
		return "", nil
	}
}

func waitForEvent(t *testing.T, c *Client, typ string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case b := <-c.send:
			et, data := parseChunk(t, b)
			if et == typ {
				return data
			}
		case <-time.After(time.Until(deadline)):
			t.Fatalf("timeout waiting for event %q", typ)
			return nil
		}
	}
}

func TestPVPRound(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("m1", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitForEvent(t, a, "shoot")
	waitForEvent(t, b, "shoot")

	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	b.moves <- moveMsg{move: MoveScissors, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["outcome"] != "win" {
		t.Errorf("a outcome = %v, want win (rock beats scissors)", ra["outcome"])
	}
	if ra["you"] != "rock" || ra["opponent"] != "scissors" {
		t.Errorf("a result moves wrong: %v", ra)
	}
	if ra["mode"] != "online" {
		t.Errorf("a mode = %v, want online", ra["mode"])
	}
	rb := waitForEvent(t, b, "result")
	if rb["outcome"] != "loss" {
		t.Errorf("b outcome = %v, want loss", rb["outcome"])
	}
	if _, ok := ra["youTimingMs"]; !ok {
		t.Errorf("expected youTimingMs in result: %v", ra)
	}
}

func TestEarlyPickDisqualifies(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("m2", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	m.ackReady(0)
	m.ackReady(1)
	// a picks well before SHOOT
	a.moves <- moveMsg{move: MovePaper, arrive: time.Now()}

	waitForEvent(t, b, "shoot")
	waitForEvent(t, a, "shoot")
	b.moves <- moveMsg{move: MoveRock, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["yourNote"] != "early" {
		t.Errorf("a note = %v, want early", ra["yourNote"])
	}
	if ra["outcome"] != "loss" {
		t.Errorf("a outcome = %v, want loss", ra["outcome"])
	}
}

func TestTimeoutLoses(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("m3", side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitForEvent(t, a, "shoot")
	// only a picks; b never does
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["yourNote"] != "" {
		t.Errorf("a note = %v, want none", ra["yourNote"])
	}
	if ra["outcome"] != "win" {
		t.Errorf("a outcome = %v, want win (b timed out)", ra["outcome"])
	}
	rb := waitForEvent(t, b, "result")
	if rb["yourNote"] != "timeout" {
		t.Errorf("b note = %v, want timeout", rb["yourNote"])
	}
	if rb["outcome"] != "loss" {
		t.Errorf("b outcome = %v, want loss", rb["outcome"])
	}
}

func TestShootEventCarriesWindow(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("sw1", side{client: a}, side{bot: true, character: "raiden"})
	m.start()

	waitForEvent(t, a, "matched")
	d := waitForEvent(t, a, "shoot")
	want := float64(shootWindow.Milliseconds())
	if got := d["windowMs"]; got != want {
		t.Errorf("windowMs = %v, want %v", got, want)
	}
	a.cancel()
}

// TestCountdownCarriesAnnouncedPlan locks v1.1: the countdown frame pre-announces
// the round deadline (~2s ahead), carries `ts`, and the shoot frame re-uses the
// same announced deadline — the window can no longer be lost to a stalled or
// dropped `shoot` frame, and lag vs skew becomes measurable client-side.
func TestCountdownCarriesAnnouncedPlan(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("pl1", side{client: a}, side{bot: true, character: "raiden"})
	m.start()

	d := waitForEvent(t, a, "countdown")
	shootAt, ok := d["shootAt"].(float64)
	if !ok || int64(shootAt) != m.shootAtMs() {
		t.Fatalf("countdown shootAt = %v, want announced %d", d["shootAt"], m.shootAtMs())
	}
	if got := d["windowMs"]; got != float64(shootWindow.Milliseconds()) {
		t.Errorf("countdown windowMs = %v, want %d", got, shootWindow.Milliseconds())
	}
	if ts, ok := d["ts"].(float64); !ok || ts <= 0 {
		t.Errorf("countdown ts = %v, want a positive server epoch-ms", d["ts"])
	}
	if announced := m.shootAtMs(); announced < time.Now().UnixMilli()+1400 || announced > time.Now().UnixMilli()+2600 {
		t.Errorf("announced shootAt %d not ~2s ahead of now", announced)
	}

	s := waitForEvent(t, a, "shoot")
	if got := int64(s["shootAt"].(float64)); got != int64(shootAt) {
		t.Errorf("shoot shootAt = %d, want the announced %d (no re-mint)", got, int64(shootAt))
	}
	if ts, ok := s["ts"].(float64); !ok || ts <= 0 {
		t.Errorf("shoot ts = %v, want a positive server epoch-ms", s["ts"])
	}

	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	ra := waitForEvent(t, a, "result")
	if ts, ok := ra["ts"].(float64); !ok || ts <= 0 {
		t.Errorf("result ts = %v, want a positive server epoch-ms", ra["ts"])
	}
	if got := int64(ra["youTimingMs"].(float64)); got > 5000 {
		t.Errorf("youTimingMs = %d, want arrival judged against the announced deadline", got)
	}
	a.cancel()
}

func TestCPURound(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("m4", side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "shoot")
	a.moves <- moveMsg{move: MovePaper, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	if ra["opponentName"] != "CPU" {
		t.Errorf("opponentName = %v, want CPU", ra["opponentName"])
	}
	if ra["mode"] != "cpu" {
		t.Errorf("mode = %v, want cpu", ra["mode"])
	}
	if ra["you"] != "paper" {
		t.Errorf("you = %v, want paper", ra["you"])
	}
	switch ra["outcome"] {
	case "win", "loss", "draw":
	default:
		t.Errorf("outcome = %v, want win/loss/draw", ra["outcome"])
	}
}

func TestDrainPendingCountsBufferedMove(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("dr1", side{client: a}, side{bot: true})
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}

	m.drainPending()

	if m.moves[0] == nil || m.moves[0].move != MoveRock {
		t.Fatalf("moves[0] = %+v, want buffered rock pick counted", m.moves[0])
	}
	if m.moves[1] != nil {
		t.Errorf("moves[1] = %+v, want nil with no bot move pending", m.moves[1])
	}
}

func TestDrainPendingLeavesEmptyChannelAsTimeout(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("dr0", side{client: a}, side{bot: true})

	m.drainPending()

	if m.moves[0] != nil || m.moves[1] != nil {
		t.Fatalf("drainPending filled empty channels: %+v / %+v", m.moves[0], m.moves[1])
	}
}
