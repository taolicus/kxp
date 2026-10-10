package main

import (
	"net/http"
	"testing"
	"time"
)

func TestPvPReadyGate(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")

	select {
	case <-a.send:
		t.Fatal("countdown started before any readiness ack")
	case <-time.After(120 * time.Millisecond):
	}

	m.ackReady(0)
	select {
	case <-a.send:
		t.Fatal("countdown started after only one readiness ack")
	case <-time.After(80 * time.Millisecond):
	}

	m.ackReady(1)
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
	waitForEvent(t, b, "shoot")
}

// TestCPUWaitsForHumanReady locks the gate for CPU matches: the countdown must
// not begin until the human acks. The client acks from the end of its
// `matched` handler, so this is a self-timing buffer — a slow client waits as
// long as it needs, a fast one pays nothing — rather than a fixed sleep.
func TestCPUWaitsForHumanReady(t *testing.T) {
	h := NewHub()
	a := newClient()
	t.Cleanup(a.cancel) // a CPU match is a series: it would play rounds for the rest of the run
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	select {
	case <-a.send:
		t.Fatal("CPU countdown started before the human acked readiness")
	case <-time.After(120 * time.Millisecond):
	}

	m.ackReady(0)
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
}

// TestCPUBotAckDoesNotReleaseGate guards the mask: the CPU side has no client to
// be told anything, so its bit must not be able to satisfy the gate on its own.
func TestCPUBotAckDoesNotReleaseGate(t *testing.T) {
	h := NewHub()
	a := newClient()
	t.Cleanup(a.cancel) // a CPU match is a series: it would play rounds for the rest of the run
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	m.ackReady(1) // the bot
	if m.allHumanReady() {
		t.Fatal("a bot ack satisfied the human readiness gate")
	}
	select {
	case <-a.send:
		t.Fatal("countdown started on a bot ack alone")
	case <-time.After(120 * time.Millisecond):
	}

	m.ackReady(0)
	waitForEvent(t, a, "countdown")
}

// TestCPUReadyTimeoutReturnsHumanToLobby covers the failure mode a CPU match can
// now hit: the human never acks, so the match is cancelled. The human goes back
// to the *lobby*, not onto the online queue — they asked for a CPU round, and
// requeueing them put them into the PvP queue for a human opponent they never
// asked for. The teardown frame says why, so the bounce is explicable.
func TestCPUReadyTimeoutReturnsHumanToLobby(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a := newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true})
	m.start()

	waitForEvent(t, a, "matched")

	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	if d["reason"] != "handshake-timeout" {
		t.Errorf("reason = %v, want handshake-timeout", d["reason"])
	}
	if _, ok := d["requeued"]; ok {
		t.Errorf("CPU human was reported requeued (%v), but a CPU timeout returns them to the lobby", d["requeued"])
	}
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if queued {
		t.Error("CPU human was put on the online queue after an unacked handshake timed out: that silently switches them from a CPU round to waiting for a human")
	}
}

// TestReadyTimeoutRequeuesAndExplainsBothSides covers the PvP half: both sides
// go back on the queue, and each is told so. Without `requeued` the client drops
// to the lobby while the server holds it in the queue — invisible, with no
// Cancel, and re-matched within the gate window again.
func TestReadyTimeoutRequeuesAndExplainsBothSides(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")

	for _, c := range []*Client{a, b} {
		d := waitForEvent(t, c, "state")
		if d["state"] != "idle" {
			t.Errorf("state event = %v, want idle", d["state"])
		}
		if d["reason"] != "handshake-timeout" {
			t.Errorf("reason = %v, want handshake-timeout", d["reason"])
		}
		if d["requeued"] != true {
			t.Errorf("requeued = %v, want true: the side went back on the queue, so the client must show the queue view", d["requeued"])
		}
	}
	// No assertion on `queueing` here: both sides land on the queue together and
	// tryMatch pairs them straight back up, so the flag is transient by design.
	// The lonely-queued-side case is pinned deterministically by the abandon test
	// below, where only the survivor is re-queued.
	a.cancel()
	b.cancel()
}

// TestReadyAbandonExplainsToSurvivor: when one side leaves before the countdown,
// the survivor is re-queued and told why. Silence here is the same defect as the
// timeout case — the round vanished for no stated reason.
func TestReadyAbandonExplainsToSurvivor(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)

	b.cancel() // side 1 leaves before the countdown

	d := waitForEvent(t, a, "state")
	if d["reason"] != "opponent-left" {
		t.Errorf("reason = %v, want opponent-left", d["reason"])
	}
	if d["requeued"] != true {
		t.Errorf("requeued = %v, want true", d["requeued"])
	}
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if !queued {
		t.Fatal("survivor not re-queued after pending abandonment")
	}
}

// TestFinishedMatchTeardownCarriesNoReason is the guard on the additive
// contract: a match that played to completion must emit a bare `state idle`.
// If it carried a stale reason, every player would be told their round was
// cancelled right after they finished it.
func TestFinishedMatchTeardownCarriesNoReason(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitForEvent(t, a, "countdown")
	waitForEvent(t, a, "shoot")
	m.abort() // ends the match without a cancellation reason

	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	if _, ok := d["reason"]; ok {
		t.Errorf("finished match carried a cancellation reason (%v), want none", d["reason"])
	}
	if _, ok := d["requeued"]; ok {
		t.Errorf("finished match was reported requeued (%v), want no flag", d["requeued"])
	}
}

func TestReadyAbandonOnLeaveRequeuesSurvivor(t *testing.T) {
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	m.ackReady(0)

	b.cancel() // side 1 leaves before the countdown

	waitForEvent(t, a, "state")
	h.mu.Lock()
	queued := a.queueing
	h.mu.Unlock()
	if !queued {
		t.Fatal("survivor not re-queued after pending abandonment")
	}
}

func TestReadyTimeoutRequeuesBoth(t *testing.T) {
	old := readyTimeout
	readyTimeout = 80 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	// Neither side acks: after readyTimeout both are re-queued and finishMatch
	// emits state idle (they may be instantly re-matched, which is fine).
	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state event = %v, want idle", d["state"])
	}
	a.cancel()
	b.cancel()
}

// An online series re-opens the ready handshake between rounds: the gate is
// the series' only exit, so `ready` has to be answerable again the moment the
// result lands -- during the pause, when the phase is already done -- and the
// countdown must not resume until both sides have answered this round. The
// pause is deliberately not shortened: the window this pins is the real one,
// and a client whose lease expired during it must be able to re-arm.
func TestOnlineSeriesReacksBetweenRounds(t *testing.T) {
	h := NewHub()
	// Registered, unlike most engine tests here: the acks go through
	// handleReady, which looks the id up the way a client's POST does.
	a := registerMoveTestClient(h, "reack-a")
	b := registerMoveTestClient(h, "reack-b")
	t.Cleanup(a.cancel)
	t.Cleanup(b.cancel)
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitEventWithin(t, a, "shoot", 20*time.Second)

	// Both sides silent: the round draws, the draw replays, and the series
	// carries on -- nothing about this round ends it.
	r1 := waitEventWithin(t, a, "result", 20*time.Second)
	if r1["seriesOver"] != false {
		t.Fatalf("round 1 seriesOver = %v, want false: the series has just begun", r1["seriesOver"])
	}
	if r1["outcome"] != "draw" {
		t.Fatalf("round 1 outcome = %v, want draw for a silent round", r1["outcome"])
	}

	// One side answers while the pause lasts -- phase is done here, and only
	// the between-rounds rule keeps the gate open -- and one answer is not
	// enough to move the match.
	if code := postReady(h, a.id).Code; code != http.StatusOK {
		t.Fatalf("ready during the round pause: status %d, want 200 while the between-rounds gate is open", code)
	}
	select {
	case raw, ok := <-a.send:
		if ok {
			if et, _ := parseChunk(t, raw); et == "countdown" {
				t.Fatal("the countdown resumed on one readiness ack")
			}
		}
	case <-time.After(6 * time.Second):
	}

	// Both sides answer now -- including the first side again, because a lease
	// older than the pause is not an answer the countdown may start from -- and
	// only then does the next round begin.
	if code := postReady(h, a.id).Code; code != http.StatusOK {
		t.Fatalf("re-ack between rounds: status %d, want 200", code)
	}
	if code := postReady(h, b.id).Code; code != http.StatusOK {
		t.Fatalf("opponent ack between rounds: status %d, want 200", code)
	}
	waitEventWithin(t, a, "countdown", 5*time.Second)
}

// A disconnect between rounds is a forfeit, not a bounce: the present side is
// awarded the series where the gate stands, with the tally it had, rather than
// being put back into a queue whose other half just left the game. The frame
// is the existing opponent-left with the series state added to it, so a tab
// open across the change reads a terminal frame rather than a new event type.
func TestOnlineSeriesDisconnectBetweenRoundsAwardsThePresentSide(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()
	a, b := newClient(), newClient()
	// Distinct fighters, so the terminal frame's identity fields round-trip to a
	// value that cannot be confused with the sender's own.
	a.character, b.character = "ronin", "kitsune"
	t.Cleanup(a.cancel)
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitEventWithin(t, a, "shoot", 20*time.Second)
	r1 := waitEventWithin(t, a, "result", 20*time.Second)
	if r1["seriesOver"] != false {
		t.Fatalf("round 1 seriesOver = %v, want false", r1["seriesOver"])
	}

	b.cancel()

	w := waitEventWithin(t, a, "opponent-left", 5*time.Second)
	if w["outcome"] != "win" {
		t.Errorf("opponent-left outcome = %v, want win for the present side", w["outcome"])
	}
	if w["seriesOver"] != true {
		t.Errorf("seriesOver = %v, want true: the departure ended the series", w["seriesOver"])
	}
	if w["roundsTarget"] != float64(defaultSeriesTarget) {
		t.Errorf("roundsTarget = %v, want %d on the deciding frame", w["roundsTarget"], defaultSeriesTarget)
	}
	if w["youRoundWins"] != float64(0) || w["oppRoundWins"] != float64(0) {
		t.Errorf("tally = %v/%v, want 0/0 after a drawn round one", w["youRoundWins"], w["oppRoundWins"])
	}
	// The terminal frame is rendered by the same result panel every other one
	// goes through, and that panel re-reads the opponent slot from the frame --
	// without these the forfeit's last screen shows a bare "(opponent)" where
	// the fighter both players chose was.
	if w["opponentCharacter"] != "kitsune" {
		t.Errorf("opponentCharacter = %v, want the opponent's fighter kitsune", w["opponentCharacter"])
	}
	if _, ok := w["opponentName"]; !ok {
		t.Error("forfeit frame carries no opponentName: the result panel would clear the opponent slot")
	}
	if _, ok := w["round"]; ok {
		t.Errorf("forfeit frame carries round = %v: it decides a series, not a round", w["round"])
	}

	d := waitForEvent(t, a, "state")
	if d["state"] != "idle" {
		t.Errorf("state = %v, want idle", d["state"])
	}
	if d["reason"] != "opponent-left" {
		t.Errorf("reason = %v, want opponent-left", d["reason"])
	}
	if _, ok := d["requeued"]; ok {
		t.Errorf("teardown carries requeued = %v: the forfeit ends the match, it does not requeue it", d["requeued"])
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if a.queueing || len(h.queue) != 0 {
		t.Errorf("a.queueing = %v, queue len = %d: the awarded side was put back in the queue",
			a.queueing, len(h.queue))
	}
}

// One side answers the between-rounds gate, the other never does: the gate's
// clock runs out and the side that answered is awarded the series. The
// timeout's judgement is taken where the gate stands, not only at the start of
// a match, and a failed gate after round one forfeits rather than requeues --
// requeuing two players out of a series they are half-way through would strand
// them as a pair nobody asked for. The short timeout is installed after round
// one's own gate was satisfied: waitReady reads it on entry, so this changes
// the between-rounds gate alone.
func TestOnlineSeriesTimeoutBetweenRoundsAwardsTheAckedSide(t *testing.T) {
	noSeriesBreak(t)
	// Short for both gates: waitReady reads it on entry, and the between-rounds
	// entry happens the instant judge's pause is over -- before this test has
	// read the result frame, so it cannot be installed after round one. The
	// opening gate still has 1.5s to collect two acks from a same-process
	// client, which is room a client on a phone would never need.
	old := readyTimeout
	readyTimeout = 1500 * time.Millisecond
	defer func() { readyTimeout = old }()

	h := NewHub()
	// Registered for handleReady's id lookup, as in the reack test.
	a := registerMoveTestClient(h, "to-between-a")
	b := registerMoveTestClient(h, "to-between-b")
	a.character, b.character = "ronin", "kitsune"
	t.Cleanup(a.cancel)
	t.Cleanup(b.cancel)
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	m.start()

	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitEventWithin(t, a, "shoot", 20*time.Second)
	r1 := waitEventWithin(t, a, "result", 20*time.Second)
	if r1["seriesOver"] != false {
		t.Fatalf("round 1 seriesOver = %v, want false", r1["seriesOver"])
	}

	// Only one side answers; the other's round-one ack is past its lease by
	// now, so it cannot stand in for this round's handshake.
	if code := postReady(h, a.id).Code; code != http.StatusOK {
		t.Fatalf("ready between rounds: status %d, want 200 while the gate is open", code)
	}

	w := waitEventWithin(t, a, "opponent-left", 5*time.Second)
	if w["outcome"] != "win" {
		t.Errorf("opponent-left outcome = %v, want win for the side that answered", w["outcome"])
	}
	if w["seriesOver"] != true {
		t.Errorf("seriesOver = %v, want true: the timeout ended the series", w["seriesOver"])
	}
	wb := waitEventWithin(t, b, "opponent-left", 5*time.Second)
	if wb["outcome"] != "loss" {
		t.Errorf("opponent-left outcome = %v, want loss for the side that never answered", wb["outcome"])
	}
	// Both sides get this frame, and both render it through the same result
	// panel, so both need the opponent's identity to keep the slot painted.
	if w["opponentCharacter"] != "kitsune" {
		t.Errorf("opponentCharacter = %v, want kitsune for the side that answered", w["opponentCharacter"])
	}
	if wb["opponentCharacter"] != "ronin" {
		t.Errorf("opponentCharacter = %v, want ronin for the side that did not", wb["opponentCharacter"])
	}

	d := waitForEvent(t, a, "state")
	if d["reason"] != "handshake-timeout" {
		t.Errorf("reason = %v, want handshake-timeout", d["reason"])
	}
	if _, ok := d["requeued"]; ok {
		t.Errorf("teardown carries requeued = %v: a gate failed mid-series forfeits, it does not requeue", d["requeued"])
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if a.queueing || b.queueing || len(h.queue) != 0 {
		t.Errorf("queueing = %v/%v, queue len = %d: the forfeit put players back in the queue",
			a.queueing, b.queueing, len(h.queue))
	}
}

// The judge's between-rounds pause is not where a match ends. A departure
// during the pause must fall through to run's gate -- where the present side
// is awarded -- instead of judge returning control as though the series were
// over. Pinned structurally rather than by waiting out a real pause: judge
// returns with the series live and the next round's countdown opened, which is
// precisely the state run's gate takes over from. The award itself is pinned
// end to end by TestOnlineSeriesDisconnectBetweenRoundsAwardsThePresentSide.
func TestADepartureDuringTheRoundPauseReachesTheGate(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()
	a, b := newClient(), newClient()
	t.Cleanup(a.cancel)
	t.Cleanup(b.cancel)
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})

	b.cancel() // leaves while judge is scoring the round and taking its pause
	if cont := judgeRoundAs(t, m, a, [2]Result{ResultDraw, ResultDraw}); !cont {
		t.Fatal("judge ended the series when a side left during the round pause -- the departure has to reach run's gate, where the present side is awarded")
	}
	if m.seriesOver {
		t.Error("seriesOver = true with the tally still 0-0")
	}
}
