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

const { loadApp } = require('./appHarness.cjs');
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