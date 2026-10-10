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

// seriesMatchForTest is a match with a CPU opponent, parked in the phase judge
// expects to walk back, with both sides having picked so the judge has
// something to score.
func seriesMatchForTest(t *testing.T) (*match, *Client) {
	t.Helper()
	noSeriesBreak(t)
	h := NewHub()
	a := newClient()
	t.Cleanup(a.cancel)
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true})
	m.phase.Store(phaseDone)
	return m, a
}

// oneRoundMatchForTest is seriesMatchForTest for the one-round length: same CPU
// shape, the length the lobby offers as the quick option.
func oneRoundMatchForTest(t *testing.T) (*match, *Client) {
	t.Helper()
	noSeriesBreak(t)
	h := NewHub()
	a := newClient()
	t.Cleanup(a.cancel)
	m := h.makeMatch(1, side{client: a}, side{bot: true})
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
	m.win = [2]int{0, defaultSeriesTarget - 1}

	if judgeRoundAs(t, m, a, [2]Result{ResultLoss, ResultWin}) {
		t.Fatal("judge kept playing after the opponent reached the target")
	}
	if !m.seriesOver {
		t.Error("seriesOver = false, want true on the round that reached the target")
	}
	if m.win[1] != defaultSeriesTarget {
		t.Errorf("tally = %v, want the opponent on %d", m.win, defaultSeriesTarget)
	}
	// The winning round is still a round that was played and reported, so the
	// round number the client was told does not move past it.
	if m.round != 1 {
		t.Errorf("round = %d, want 1 -- the final round is counted, not skipped", m.round)
	}
}

// A drawn round in a one-round match is the last round. The lobby offers one
// round as the quick option, and the offer is one round: replaying the draw
// would play a second one, which is the series the player declined. It is also
// the behaviour this mode had before there was a series -- a single round, whose
// result is final whatever it was -- so a draw ends it and the client offers the
// rematch like any other final result.
func TestADrawEndsAOneRoundMatch(t *testing.T) {
	m, a := oneRoundMatchForTest(t)

	if judgeRoundAs(t, m, a, [2]Result{ResultDraw, ResultDraw}) {
		t.Fatal("judge kept playing after the only round of a one-round match")
	}
	if !m.seriesOver {
		t.Error("seriesOver = false, want true -- the draw was the whole match")
	}
	// A draw is still worth nothing to either side; the round is not retroactively
	// a win for whoever the player might have preferred.
	if m.win != [2]int{0, 0} {
		t.Errorf("tally = %v, want 0-0", m.win)
	}

	// On the wire, because that is what the client acts on: the frame says the
	// match is over, so the result screen offers the rematch exactly as it does
	// after a win. Driven through judge directly because the CPU's move is
	// random -- an end-to-end draw would be a coin flip, not a test.
	typ, frame := parseChunk(t, <-a.send)
	if typ != "result" {
		t.Fatalf("announced %q, want the result", typ)
	}
	if frame["seriesOver"] != true {
		t.Errorf("result seriesOver = %v, want true -- the client reads this to offer the rematch",
			frame["seriesOver"])
	}
	if frame["outcome"] != "draw" {
		t.Errorf("result outcome = %v, want draw", frame["outcome"])
	}
	if frame["youRoundWins"] != float64(0) || frame["oppRoundWins"] != float64(0) {
		t.Errorf("announced tally = %v/%v, want 0/0", frame["youRoundWins"], frame["oppRoundWins"])
	}
}

// The other direction, and the reason the rule is scoped to a single round: in
// a series a draw still replays, so two sides that cannot finish each other off
// never reach a result nobody won. Pinned by TestSeriesTallyCountsWinsAndIgnores
// Draws at length three; this is the same fact at the one-round length's
// neighbour, where the draw ends it.
func TestADrawStillReplaysInALongerSeries(t *testing.T) {
	m, a := seriesMatchForTest(t)
	if !judgeRoundAs(t, m, a, [2]Result{ResultDraw, ResultDraw}) {
		t.Fatal("a draw ended a first-to-three series")
	}
	if m.seriesOver {
		t.Error("seriesOver set on a drawn round of a first-to-three series")
	}
	if m.round != 2 {
		t.Errorf("round = %d, want 2 -- the draw is replayed", m.round)
	}
}

// The ladder's request says its drawers replay -- a drawn round must not decide
// a floor -- and it is that message, not the length, that ends a match on a
// draw. This is the exception's other neighbour: the same target as
// TestADrawEndsAOneRoundMatch, but at drawEnds false the draw is not the end of
// the floor.
func TestADrawReplaysInAOneRoundLadderFloor(t *testing.T) {
	m, a := oneRoundMatchForTest(t)
	m.drawEnds = false

	if !judgeRoundAs(t, m, a, [2]Result{ResultDraw, ResultDraw}) {
		t.Fatal("judge ended a one-round match asked to replay draws")
	}
	if m.seriesOver {
		t.Error("seriesOver set on a drawn round of a ladder floor")
	}
	if m.round != 2 {
		t.Errorf("round = %d, want 2 -- the draw is replayed", m.round)
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
	// The negative direction of the series rule: a one-round online match — the
	// length the lobby posts for it — is not a series, whatever else the queue
	// can now be asked for. It ends on its first round whatever that round was,
	// announces no target, and never opens a second countdown; the draw that
	// would replay in a first-to-three ends it here, because `drawEnds` defaults
	// to true at this target and a match one round long is whatever its round
	// came to. First-to-three PvP is the other neighbour:
	// TestAPVPMatchCanBeAFirstToThree.
	noSeriesBreak(t)
	h := NewHub()
	a, b := newClient(), newClient()
	m := h.makeMatch(1, side{client: a}, side{client: b})
	if m.seriesMatch() {
		t.Fatal("a one-round PvP match reports itself as a series")
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
		// Same rule as `matched`, on the frame a scoreboard would be drawn from.
		// A client that took the target here would draw a three-pip row over a
		// match that has exactly one round in it.
		if _, ok := r["roundsTarget"]; ok {
			t.Errorf("%s result carries roundsTarget = %v, want none", name, r["roundsTarget"])
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

// A queued match with no bot and a length to play is a series: the half of
// game-mode-architecture that the between-rounds ready gate unblocked. The rule
// is derived, not flagged -- `seriesMatch` reads the sides and `drawEnds` --
// and this pins the bot-less side of it: judge keeps the loop running across a
// draw and a partial tally until someone reaches the target, exactly as a CPU
// match always did. Driven through judge directly because the gate between
// rounds is run's business; that gate is pinned end to end by the
// TestOnlineSeries* tests in ready_test.go.
func TestAPVPMatchCanBeAFirstToThree(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()
	a, b := newClient(), newClient()
	t.Cleanup(a.cancel)
	t.Cleanup(b.cancel)
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{client: b})
	if !m.seriesMatch() {
		t.Fatal("a first-to-three match without a bot does not report itself as a series")
	}

	// A drawn round replays rather than deciding anything...
	if !judgeRoundAs(t, m, a, [2]Result{ResultDraw, ResultDraw}) {
		t.Fatal("judge ended the series on a draw")
	}
	// ...and three decisive wins end it.
	for won := 1; won < defaultSeriesTarget; won++ {
		if !judgeRoundAs(t, m, a, [2]Result{ResultWin, ResultLoss}) {
			t.Fatalf("judge ended the series after %d of %d wins", won, defaultSeriesTarget)
		}
	}
	if judgeRoundAs(t, m, a, [2]Result{ResultWin, ResultLoss}) {
		t.Fatal("judge kept playing after the target was reached")
	}
	if m.win != [2]int{defaultSeriesTarget, 0} {
		t.Errorf("tally = %v, want %d-0", m.win, defaultSeriesTarget)
	}
	if !m.seriesOver {
		t.Error("seriesOver = false, want true on the round that reached the target")
	}
}

// A series one round long ends on that round. The lobby offers it as the quick
// option, so this is the difference between a mode and a decoration: judge has to
// stop the loop, or the player asked for one round and got five.
func TestASeriesOfOneRoundEndsImmediately(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()
	a := newClient()
	m := h.makeMatch(1, side{client: a}, side{bot: true})
	m.start()
	m.ackReady(0)

	first := waitEventWithin(t, a, "result", 20*time.Second)
	if first["roundsTarget"] != float64(1) {
		t.Errorf("roundsTarget = %v, want 1", first["roundsTarget"])
	}
	if first["seriesOver"] != true {
		t.Errorf("seriesOver = %v, want true -- one round was the whole series", first["seriesOver"])
	}
	if first["youRoundWins"] != float64(0) && first["oppRoundWins"] != float64(0) {
		t.Errorf("a void should have been tallied 0/1, got %v/%v",
			first["youRoundWins"], first["oppRoundWins"])
	}

	select {
	case b, ok := <-a.send:
		if ok {
			et, data := parseChunk(t, b)
			if et != "state" || data["state"] != "idle" {
				t.Fatalf("a one-round match sent %s/%v; want the idle teardown, not another round", et, data)
			}
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a one-round match neither went idle nor carried on")
	}
}

// Only a match with a series announces a target. The client draws a pip per
// round win still needed and needs the target to know how many, so it has to
// arrive before round one's result -- and the one-round length, whatever the
// lobby posts, cannot promise one. The queue now honors a length, so the other
// half of the rule bites too: a first-to-three online match is a series and
// its `matched` frames carry the target like a CPU one's.
func TestOnlyASeriesAnnouncesARoundsTarget(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()

	cpu := newClient()
	cm := h.makeMatch(defaultSeriesTarget, side{client: cpu}, side{bot: true})
	cm.start()
	md := waitForEvent(t, cpu, "matched")
	if md["roundsTarget"] != float64(defaultSeriesTarget) {
		t.Errorf("cpu matched roundsTarget = %v, want %d -- the scoreboard has to be drawable before round one",
			md["roundsTarget"], defaultSeriesTarget)
	}
	cpu.cancel()

	pvpA, pvpB := newClient(), newClient()
	pm := h.makeMatch(1, side{client: pvpA}, side{client: pvpB})
	pm.start()
	for name, c := range map[string]*Client{"a": pvpA, "b": pvpB} {
		frame := waitForEvent(t, c, "matched")
		if _, ok := frame["roundsTarget"]; ok {
			t.Errorf("%s matched carries roundsTarget = %v; a one-round match has no series to score",
				name, frame["roundsTarget"])
		}
	}
	pvpA.cancel()
	pvpB.cancel()

	// The rule in the other direction: length carries, so the target arrives
	// before round one here as well. This half fails against the old single-
	// round PvP rule.
	longA, longB := newClient(), newClient()
	lm := h.makeMatch(defaultSeriesTarget, side{client: longA}, side{client: longB})
	lm.start()
	for name, c := range map[string]*Client{"a": longA, "b": longB} {
		frame := waitForEvent(t, c, "matched")
		if frame["roundsTarget"] != float64(defaultSeriesTarget) {
			t.Errorf("%s matched roundsTarget = %v, want %d -- a first-to-three online match has a scoreboard to draw",
				name, frame["roundsTarget"], defaultSeriesTarget)
		}
	}
	longA.cancel()
	longB.cancel()
}

// TestCPUSeriesPlaysTheNextRound plays two real rounds. The human side sends
// nothing, so the round resolves void and the CPU takes it -- deterministic
// without having to guess the bot's random move, and it exercises the same path
// a dropped connection takes.
func TestCPUSeriesPlaysTheNextRound(t *testing.T) {
	noSeriesBreak(t)
	h := NewHub()
	a := newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true})
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
	if first["roundsTarget"] != float64(defaultSeriesTarget) {
		t.Errorf("roundsTarget = %v, want %d", first["roundsTarget"], defaultSeriesTarget)
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
		t.Errorf("round 2 seriesOver = %v, want false at 2 of %d", r2["seriesOver"], defaultSeriesTarget)
	}

	a.cancel()
}

// A round's picks must not leak into the next one. m.moves is read by resolve,
// so a leftover pointer would be judged as a move the player never made -- the
// second round would resolve on round one's pick and never open its window.
func TestBeginRoundClearsTheLastRoundsPicks(t *testing.T) {
	h := NewHub()
	a := newClient()
	m := h.makeMatch(defaultSeriesTarget, side{client: a}, side{bot: true})

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
