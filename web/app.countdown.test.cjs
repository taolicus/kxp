// Drives the real web/app.js countdown paint path under test.
//
// The countdown chain is the part of the client that has actually broken twice:
// a stale paint, then a timer that armed once and never re-armed. Both bugs were
// invisible to every other check here -- kxp.js tests exercise the pure schedule
// helpers in isolation, and the protocol probes verify frames arriving on the
// wire, not the beats the client puts on screen. Neither can see whether
// app.js re-arms its timer.
//
// So this loads the actual app.js source into a stubbed browser context and
// watches #count. The countdown only touches setCount,
// timers and Date.now, all of which are stubbed in appHarness.cjs, shared with
// the SSE snapshot tests so neither file carries its own copy.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp, BGS } = require('./appHarness.cjs');
const SM = require('./machine.js');

// The three beat labels, in the order the server sends them.
const BEATS = ['READY', 'KA', 'CHI'];

// distinct drops repeated readings. runUntil samples the count after every timer it
// fires, so a beat that legitimately spans several checks appears several times; what
// the player sees is the sequence of changes.
const distinct = (xs) => xs.filter((v, i) => v !== xs[i - 1]);

// announce replays what the server does: the first countdown frame opens the
// gate, and the later beats carry the same shootAt (which app.js dedupes).
// Frames land in the same tick, which is what a burst over a slow link looks
// like.
function announce(app, shootAt, firstN) {
  for (const d of beats(shootAt, firstN)) {
    runInContext(`planFromCountdown(${JSON.stringify(d)})`, app.ctx);
  }
  return app.runUntil(shootAt);
}

function beats(shootAt, firstN) {
  return [
    { n: firstN, shootAt, windowMs: 2000 },
    { n: 'KA', shootAt, windowMs: 2000 },
    { n: 'CHI', shootAt, windowMs: 2000 },
  ];
}

test('app.js paints every countdown beat, not just the first two', () => {
  // The regression: the timer armed once, so READY then KA painted and CHI never
  // appeared -- the count jumped from KA straight to PUN. This asserts the full
  // sequence against the real source, so a one-shot timer fails here.
  const shootAt = 1700000003000;
  const app = loadApp();
  runInContext("state = 'countdown'", app.ctx);
  const painted = announce(app, shootAt, 'READY');
  assert.deepEqual(painted, ['READY', 'KA', 'CHI']);
});

test('app.js skips only the beats a late first frame has already passed', () => {
  // The delay this change exists for. Whatever has already gone is dropped;
  // everything still ahead must still be painted.
  for (const [lag, want] of [
    [0, ['READY', 'KA', 'CHI']],
    [1000, ['KA', 'CHI']],
    [2000, ['CHI']],
  ]) {
    const shootAt = 1700000003000;
    const app = loadApp();
    app.setClock(1700000000000 + lag); // first frame lands this late
    runInContext("state = 'countdown'", app.ctx);
    const painted = announce(app, shootAt, 'READY');
    assert.deepEqual(painted, want, `first frame +${lag}ms`);
  }
});

test('a repeated countdown frame re-derives without skipping or reprinting', () => {
  // The server names the same shootAt on every beat, so each frame after the first
  // is a repeat. It has to be a no-op *visibly*: the count must neither skip a beat
  // nor reprint the one already up.
  //
  // This used to assert the frames were dropped outright. They are not any more --
  // each one re-derives from the clock, which is what lets a bad reading be
  // corrected -- so the contract is now what the player sees, not which frames the
  // client ignored. The readings are accumulated across both windows because the
  // first beat is painted before the first runUntil.
  const shootAt = 1700000003000;
  const app = loadApp();
  runInContext("state = 'countdown'", app.ctx);
  app.setClock(1700000000000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'READY')[0])})`, app.ctx);
  const seen = app.runUntil(1700000001000); // first beat painted; tick armed

  app.setClock(1700000001000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'READY')[1])})`, app.ctx);
  const painted = seen.concat(app.runUntil(shootAt));

  assert.deepEqual(painted, ['READY', 'KA', 'CHI'], 'no beat skipped, none printed twice');
  assert.equal(app.count(), 'CHI', 'count settles on the last beat before PUN');
});

test('the countdown survives a clock that reads wrong and then comes back', () => {
  // The regression this change exists for. clockSkew is sampled once at connect and
  // never corrected, so a phone whose wall clock steps between the snapshot and the
  // round hands the countdown a badly wrong "time until PUN".
  //
  // The old chain measured every delay from the step before it and was built once,
  // from the first frame: one bad reading scheduled a single long timer, and the
  // repeat frames that could have corrected it were dropped as duplicates. The count
  // therefore sat blank until PUN with the pick window still open. Re-deriving caps
  // the damage at one tick, and a frame re-arms the check, so the countdown picks
  // itself back up the moment the clock is right.
  const shootAt = 1700000003000;
  const app = loadApp();
  runInContext("state = 'countdown'", app.ctx);
  app.setClock(1700000000000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'READY')[0])})`, app.ctx);
  assert.equal(app.count(), 'READY', 'sanity: READY is up before the clock moves');

  // The clock steps 4s backwards, and a frame arrives while it reads wrong. This is
  // the moment the old chain died: it read a deadline ~7s out, armed one long timer,
  // and had nothing left that could re-check.
  app.setClock(1699999996000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'KA')[0])})`, app.ctx);
  assert.equal(app.count(), 'READY', 'a wrong reading repaints nothing');

  // The clock settles and the next frame lands. The countdown carries on from where
  // it was rather than having to be restarted by hand.
  app.setClock(1700000001000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'CHI')[1])})`, app.ctx);
  const painted = ['READY'].concat(distinct(app.runUntil(shootAt)));
  assert.deepEqual(painted, ['READY', 'KA', 'CHI'], 'the beats resume once the clock is right');
});

// lateFrame replays the whole path a real client takes when its link is slow:
// connect, get matched, then have the first countdown frame turn up `lag` ms
// after the server announced the schedule. It drives the real state machine
// because the symptom is a transition sequence, not just a count label --
// MATCH FOUND with no countdown between it and PUN is what the player sees.
function lateFrame(lag, shootAt) {
  const app = loadApp({ next: SM.next });
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: null, now: 1700000000000, online: 0 });
  runInContext('transition("matched", {})', app.ctx);
  app.setClock(1700000000000 + lag); // the first frame lands this late
  app.fire('countdown', { n: 'READY', shootAt, windowMs: 2000 });
  return app;
}

test('app.js loses exactly one countdown beat per second of first-frame delay', () => {
  // The delivery-lag envelope, pinned at its exact boundary.
  //
  // round.go announces shootAt three seconds ahead and sends the first beat at
  // that same instant, so the lead equals the countdown length and there is no
  // margin: a link that takes one second to deliver the first frame loses
  // exactly one beat, and one that takes three has nothing left to paint.
  //
  // countdownSlot is correct to report no beat once msUntilPun <= 0 -- kxp.js
  // does that deliberately, so a late frame cannot flash a beat with no time
  // behind it. The cliff is therefore a property of the server's schedule, not
  // a bug in the client, and this test exists to make the envelope explicit:
  // changing the schedule has to move this table on purpose.
  const shootAt = 1700000003000;
  for (const [lag, want] of [
    [0, ['READY', 'KA', 'CHI']],
    [1000, ['KA', 'CHI']],
    [2000, ['CHI']],
    [2999, ['CHI']],
    [3000, []],
    [3500, []],
  ]) {
    const app = lateFrame(lag, shootAt);
    // Collapse repeats: runUntil samples after every timer, and not every timer
    // repaints, so consecutive equal samples are one paint observed twice.
    const beats = app
      .runUntil(shootAt + 2500)
      .filter((p) => BEATS.includes(p))
      .filter((p, i, all) => p !== all[i - 1]);
    assert.deepEqual(beats, want, `first frame +${lag}ms late`);
  }
});

test('a second round arrives on a countdown frame that carries none of the match', async () => {
  // A non-final result is followed by the next round's countdown. That frame
  // carries the schedule and nothing else -- no background, no character -- so a
  // client that rebuilds the match screen from it replaces the opponent with a
  // generic "Opponent" and re-rolls the stage. Invisible in round one, where the
  // screen was built by `matched`, which does carry them: the damage first shows
  // up in round two, after the player has already chosen a character.
  const shootAt = 1700000003000;
  const app = loadApp({ next: SM.next });
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: null, now: 1700000000000, online: 0 });
  app.fire('matched', { opponentName: 'CPU', background: BGS[0] });
  app.loadImages();
  await app.settle();
  app.fire('countdown', { n: 'READY', shootAt, windowMs: 2000 });
  app.fire('shoot', { windowMs: 2000, shootAt });
  app.runUntil(shootAt + 2500);
  app.fire('result', {
    outcome: 'win', mode: 'cpu', opponentName: 'CPU', seriesOver: false,
  });
  assert.equal(runInContext('state', app.ctx), 'result');

  const opponent = app.html('#opp-slot');
  assert.match(opponent, /cpu/i, 'sanity: the first round named the opponent');

  app.fire('countdown', { n: 'READY', shootAt: shootAt + 20000, windowMs: 2000 });
  assert.equal(runInContext('state', app.ctx), 'countdown', 'the round starts');
  assert.equal(app.html('#opp-slot'), opponent, 'and the opponent is still who it was');
  assert.equal(app.bgName(), BGS[0], 'on the background the match started with');
  // The previous round's panel must not sit on top of the new round: resetGame
  // is what hides the timing panel and the rematch buttons.
  assert.ok(app.el('#btn-again').classList.contains('hidden'), 'no stale rematch button');
  assert.ok(app.el('#timing').classList.contains('hidden'), 'no stale timing panel');
});

// playsRounds drives the real app.js through `n` rounds of a CPU series: each
// one is announced, opened, and then judged with the tally the server would
// report for it. It returns after the last result has been rendered, so a test
// can assert on the screen the player is left looking at.
async function playRound(app, base, { you, opp, over }) {
  app.fire('countdown', { n: 'READY', shootAt: base, windowMs: 2000 });
  app.fire('shoot', { windowMs: 2000, shootAt: base });
  app.runUntil(base + 2500);
  app.fire('result', {
    outcome: you > opp ? 'win' : 'loss',
    mode: 'cpu',
    opponentName: 'CPU',
    round: you + opp + 1,
    youRoundWins: you,
    oppRoundWins: opp,
    roundsTarget: 3,
    seriesOver: over,
  });
}

async function cpuSeries(app) {
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: null, now: 1700000000000, online: 0 });
  app.fire('matched', { opponentName: 'CPU', background: BGS[0] });
  app.loadImages();
  await app.settle();
}

test('a series round shows the running score and withholds the rematch until the last round', async () => {
  // A CPU match is a series, so the score is the thing being played for and has
  // to be on screen for every round -- including through the next countdown,
  // which clears the round panel the score arrived with. "Play Again" has to
  // mean "the match is over": offering it after round one made a series look
  // finished, and a tap on it abandoned a match still being played.
  const app = loadApp({ next: SM.next });
  await cpuSeries(app);

  await playRound(app, 1700000003000, { you: 1, opp: 0, over: false });
  const score = app.el('#series-score').textContent;
  assert.match(score, /1 \u2013 0 of 3/, 'the score after round one');
  assert.ok(app.el('#btn-again').classList.contains('hidden'), 'no rematch mid-series');
  assert.ok(app.el('#btn-mode').classList.contains('hidden'), 'and no mode switch either');

  // The next round counts down over the panel resetGame just cleared; the score
  // is not part of that panel.
  app.fire('countdown', { n: 'READY', shootAt: 1700000010000, windowMs: 2000 });
  assert.equal(app.el('#series-score').textContent, score, 'the score survives into round two');
  assert.ok(app.el('#btn-again').classList.contains('hidden'), 'still no rematch');

  await playRound(app, 1700000013000, { you: 2, opp: 1, over: false });
  assert.match(app.el('#series-score').textContent, /2 \u2013 1 of 3/, 'the score after round two');

  await playRound(app, 1700000023000, { you: 3, opp: 1, over: true });
  assert.match(app.el('#series-score').textContent, /3 \u2013 1 of 3/, 'the final score');
  assert.ok(!app.el('#btn-again').classList.contains('hidden'), 'the final round offers the rematch');
});

test('a result with no series fields still offers the rematch', async () => {
  // The pin against over-correcting. The series fields are additive on the wire,
  // so a tab open across a deploy sees results without them until it
  // refreshes; treating that as "not over" would strand the player on a result
  // screen with no way to play again. A missing roundsTarget means the mode has
  // no series, and every result in it is final.
  const app = loadApp({ next: SM.next });
  await cpuSeries(app);

  app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });
  app.fire('shoot', { windowMs: 2000, shootAt: 1700000003000 });
  app.runUntil(1700000005500);
  app.fire('result', { outcome: 'win', mode: 'cpu', opponentName: 'CPU' });

  assert.ok(!app.el('#btn-again').classList.contains('hidden'), 'the rematch is offered');
  assert.ok(!app.el('#btn-mode').classList.contains('hidden'), 'and so is the mode switch');
  assert.ok(app.el('#series-score').classList.contains('hidden'), 'with no scoreboard to show');
});

test('the score does not outlive the match', async () => {
  // The lobby is where a match ends -- finished, cancelled or abandoned -- so
  // that is where the series it belonged to ends. A score left on screen would
  // be the previous match's, showing above the next one's countdown.
  const app = loadApp({ next: SM.next });
  await cpuSeries(app);
  await playRound(app, 1700000003000, { you: 1, opp: 0, over: false });
  assert.ok(!app.el('#series-score').classList.contains('hidden'), 'sanity: a score is up');

  // "Change mode" is one of the two ways off a result screen, and it goes to
  // the lobby -- which is where enter.lobby forgets the series.
  runInContext("transition('mode', {})", app.ctx);
  assert.equal(runInContext('seriesScore', app.ctx), '', 'the series is forgotten');
  assert.ok(app.el('#series-score').classList.contains('hidden'), 'and off the screen');
});

test('a client that misses the whole countdown is still told to shoot', () => {
  // The other half of the symptom. Losing the beats must not also lose the pick
  // window: whatever buys the margin back, a client whose first frame arrives
  // after the deadline still has to reach shoot and still has to be given the
  // PUN cue, or a margin fix would trade a silent round for a client that never
  // learns the window opened at all.
  const shootAt = 1700000003000;
  const app = lateFrame(3500, shootAt);
  app.runUntil(shootAt + 2500);
  assert.ok(
    app.transitions.some(([from, ev]) => from === 'countdown' && ev === 'shoot'),
    'still transitions into shoot'
  );
  assert.match(app.count(), /PUN/i, 'and still paints the PUN cue');
});