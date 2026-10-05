package main

import (
	"testing"
	"time"
)

// A match that plays more than one round: first to roundsTarget decisive wins,
// draws replayed, a void round won by the opponent. The rules are
// docs/tasks/open/game-mode-architecture.md; these are split between driving
// nextRound's bookkeeping directly (fast, and the only way to reach a third
// round without waiting out two countdowns) and playing real rounds end to end.

// seriesBreak is three seconds of pacing between rounds. The bookkeeping tests
// call nextRound directly, so they would otherwise spend that long per call.
func noSeriesBreak(t *testing.T) {
	t.Helper()
	old := seriesBreak
	seriesBreak = 0
	t.Cleanup(func() { seriesBreak = old })
}

// seriesMatchForTest is a match with a CPU opponent -- the only shape that is a
// series today -- parked in the phase judge expects to walk back, with both sides
// having picked so the judge has something to score.
func seriesMatchForTest(t *testing.T) (*match, *Client) {
	t.Helper()
	noSeriesBreak(t)
	h := NewHub()
	a := newClient()
	t.Cleanup(a.cancel)
	m := h.makeMatch("s1", side{client: a}, side{bot: true})
	m.phase.Store(phaseDone)
	return m, a
}

// judgeRoundAs runs judge over a round whose outcome is given, so a series test
// can reach a third or fourth round without playing two countdowns to get there.
// The moves are set to make the *stated* outcome true: a win needs the beats, a
// draw needs the same move twice, and a void needs no move at all.
func judgeRoundAs(t *testing.T, m *match, a *Client, res [2]Result) bool {
	t.Helper()
	m.phase.Store(phaseDone)
	m.beginRound()
	switch {
	case res[0] == ResultVoid:
		m.moves[0] = nil
		m.moves[1] = &moveMsg{move: MoveRock, arrive: time.Now()}
	case res[0] == ResultDraw:
		m.moves[0] = &moveMsg{move: MoveRock, arrive: time.Now()}
		m.moves[1] = &moveMsg{move: MoveRock, arrive: time.Now()}
	case res[0] == ResultWin:
		m.moves[0] = &moveMsg{move: MoveRock, arrive: time.Now()}
		m.moves[1] = &moveMsg{move: MoveScissors, arrive: time.Now()}
	default:
		m.moves[0] = &moveMsg{move: MoveScissors, arrive: time.Now()}
		m.moves[1] = &moveMsg{move: MoveRock, arrive: time.Now()}
	}
	// The judge measures arrival against the announced deadline, so the picks
	// have to land inside its window: a synthetic arrival judged against a zero
	// shootAt is late for both sides, which is a different round entirely.
	now := time.Now()
	m.shootAt.Store(&now)
	at := now.Add(500 * time.Millisecond)
	for i := range m.moves {
		if m.moves[i] != nil {
			m.moves[i].arrive = at
		}
	}
	if got, _ := m.judgeRound(); got != res {
		t.Fatalf("asked for a %v round, the engine judged %v", res, got)
	}
	return m.judge()
}

func TestSeriesTallyCountsWinsAndIgnoresDraws(t *testing.T) {
	m, a := seriesMatchForTest(t)

	if !judgeRoundAs(t, m, a, [2]Result{ResultWin, ResultLoss}) {
		t.Fatal("judge ended the series after one win of three")
	}
	if m.win[0] != 1 || m.win[1] != 0 {
		t.Fatalf("tally = %v, want 1-0", m.win)
	}
	if m.round != 2 {
		t.Errorf("round = %d, want 2", m.round)
	}
	if m.seriesOver {
		t.Error("seriesOver set with nobody at the target")
	}

	// A draw is worth nothing to either side and must replay: a series decided
	// by draws alone would end on a round nobody won.
	if !judgeRoundAs(t, m, a, [2]Result{ResultDraw, ResultDraw}) {
		t.Fatal("judge ended the series on a draw")
	}
	if m.win != [2]int{1, 0} {
		t.Errorf("tally = %v, want 1-0 unchanged by the draw", m.win)
	}
	if m.round != 3 {
		t.Errorf("round = %d, want 3 -- a drawn round is still a round played", m.round)
	}
}

func TestSeriesEndsWhenTheTargetIsReached(t *testing.T) {
	m, a := seriesMatchForTest(t)
	m.win = [2]int{0, seriesTarget - 1}

	if judgeRoundAs(t, m, a, [2]Result{ResultLoss, ResultWin}) {
		t.Fatal("judge kept playing after the opponent reached the target")
	}
	if !m.seriesOver {
		t.Error("seriesOver = false, want true on the round that reached the target")
	}
	if m.win[1] != seriesTarget {
		t.Errorf("tally = %v, want the opponent on %d", m.win, seriesTarget)
	}
	// The winning round is still a round that was played and reported, so the
	// round number the client was told does not move past it.
	if m.round != 1 {
		t.Errorf("round = %d, want 1 -- the final round is counted, not skipped", m.round)
	}
}

// A void round is connectivity-safe scoring's no-contest: it is a round win for
// the opponent and costs the side that dropped nothing. It must be tallied the
// same way an ordinary win is, or a player who drops every round can never end
// a series against a bot.
func TestSeriesVoidIsARoundWinForTheOpponent(t *testing.T) {
	m, a := seriesMatchForTest(t)

	if !judgeRoundAs(t, m, a, [2]Result{ResultVoid, ResultWin}) {
		t.Fatal("judge ended the series after one round")
	}
	if m.win[0] != 0 || m.win[1] != 1 {
		t.Fatalf("tally = %v, want 0-1: the void belongs to the side that was there", m.win)
	}
}

func TestPVPMatchEndsOnItsFirstRound(t *testing.T) {
	// The CPU-first half of the task: a PvP match is not a series yet, because
	// re-opening the ready handshake per round is the half that has not landed.
	// Playing one here would leave two players in a match neither can leave.
	noSeriesBreak(t)
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch("pvps", side{client: a}, side{client: b})
	if m.seriesMatch() {
		t.Fatal("a PvP match reports itself as a series")
	}

	m.start()
	waitForEvent(t, a, "matched")
	waitForEvent(t, b, "matched")
	m.ackReady(0)
	m.ackReady(1)
	waitEventWithin(t, a, "shoot", 20*time.Second)
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}
	b.moves <- moveMsg{move: MoveRock, arrive: time.Now()}

	ra := waitForEvent(t, a, "result")
	rb := waitForEvent(t, b, "result")
	for name, r := range map[string]map[string]any{"a": ra, "b": rb} {
		if r["outcome"] != "draw" {
			t.Errorf("%s outcome = %v, want draw", name, r["outcome"])
		}
		if r["seriesOver"] != true {
			t.Errorf("%s seriesOver = %v, want true -- the match ended with this result", name, r["seriesOver"])
		}
		if r["round"] != float64(1) {
			t.Errorf("%s round = %v, want 1", name, r["round"])
		}
	}

	// Nothing follows it: a second countdown is the series, and this match must
	// not have one. The window is generous on purpose -- it is a negative
	// assertion about absence, so it can only be as good as its patience.
	select {
	case b, ok := <-a.send:
		if ok {
			if et, _ := parseChunk(t, b); et == "countdown" {
				t.Fatal("a PvP match started a second round")
			}
		}
	case <-time.After(1200 * time.Millisecond):
	}
}

// TestCPUSeriesPlaysTheNextRound plays two real rounds. The human side sends
// nothing, so the round resolves void and the CPU takes it -- deterministic
// without having to guess the bot's random move, and it exercises the same path
// a dropped connection takes.
func TestCPUSeriesPlaysTheNextRound(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()
	a := newClient()
	m := h.makeMatch("cs", side{client: a}, side{bot: true})
	m.start()
	m.ackReady(0)

	first := waitEventWithin(t, a, "result", 20*time.Second)
	if first["outcome"] != "void" {
		t.Fatalf("round 1 outcome = %v, want void for the silent side", first["outcome"])
	}
	if first["round"] != float64(1) {
		t.Errorf("round 1 round = %v, want 1", first["round"])
	}
	// The tally is the score *after* the round that just resolved, which is what
	// a scoreboard has to show: this void is the CPU's first round win.
	if first["youRoundWins"] != float64(0) || first["oppRoundWins"] != float64(1) {
		t.Errorf("round 1 tally = %v/%v, want 0/1",
			first["youRoundWins"], first["oppRoundWins"])
	}
	if first["seriesOver"] != false {
		t.Errorf("round 1 seriesOver = %v, want false", first["seriesOver"])
	}
	if first["roundsTarget"] != float64(seriesTarget) {
		t.Errorf("roundsTarget = %v, want %d", first["roundsTarget"], seriesTarget)
	}

	// The second round is announced by a fresh countdown: same opponent, same
	// stage, and its own deadline rather than a replay of the last one.
	second := waitEventWithin(t, a, "countdown", 20*time.Second)
	if second["shootAt"] == first["ts"] {
		t.Error("round 2 reuses round 1's schedule")
	}
	waitEventWithin(t, a, "shoot", 20*time.Second)

	r2 := waitEventWithin(t, a, "result", 20*time.Second)
	if r2["round"] != float64(2) {
		t.Errorf("round 2 round = %v, want 2", r2["round"])
	}
	if r2["oppRoundWins"] != float64(2) || r2["youRoundWins"] != float64(0) {
		t.Errorf("round 2 tally = %v/%v, want 0/2", r2["youRoundWins"], r2["oppRoundWins"])
	}
	if r2["seriesOver"] != false {
		t.Errorf("round 2 seriesOver = %v, want false at 2 of %d", r2["seriesOver"], seriesTarget)
	}

	a.cancel()
}

// A round's picks must not leak into the next one. m.moves is read by resolve,
// so a leftover pointer would be judged as a move the player never made -- the
// second round would resolve on round one's pick and never open its window.
func TestBeginRoundClearsTheLastRoundsPicks(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch("s2", side{client: a}, side{bot: true})

	m.moves[0] = &moveMsg{move: MoveRock, arrive: time.Now()}
	m.moves[1] = &moveMsg{move: MoveRock, arrive: time.Now()}
	m.beginRound()

	if m.moves[0] != nil || m.moves[1] != nil {
		t.Fatalf("nextRound left last round's picks in place: %+v / %+v", m.moves[0], m.moves[1])
	}
}

// The channel half of the same rule, and the part that only a series can break.
// The shoot loop stops reading when the window closes, so a pick accepted before
// the deadline can still be buffered when the round is judged. In a single-round
// match it had nowhere to go; in a series the next round's loop would take it as
// that round's pick, against a deadline its arrival predates -- so a tap the
// server already closed the window on would decide the *next* round, as an
// `early` loss the player never saw belong to it.
func TestAJudgedRoundDiscardsPicksStillBuffered(t *testing.T) {
	m, a := seriesMatchForTest(t)
	// Buffered while the round was being judged: already too late for it.
	a.moves <- moveMsg{move: MoveRock, arrive: time.Now()}

	// closeRound is the step a real round ends with, so this is the call site
	// under test rather than the helper it happens to call.
	m.closeRound()

	if _, ok := m.takeFirst(0); ok {
		t.Error("a pick buffered for the closed round survived the discard")
	}
}

// And the negative direction, because the fix is one line in the wrong place
// away from breaking it: a pick that arrived *before* its round's window opened
// is judged `early` and loses. Discarding it at the start of a round instead of
// after the judgement would silently turn that into a timeout `void`, which is a
// different result for the same input.
func TestAPickBeforeTheWindowIsJudgedEarlyNotDiscarded(t *testing.T) {
	m, _ := seriesMatchForTest(t)
	m.beginRound()
	if _, ok := m.takeFirst(0); ok {
		t.Error("beginRound discarded a pick that belonged to the round about to open")
	}
}
