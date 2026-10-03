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

test('app.js dedupes the repeated countdown frames', () => {
  // The server names the same shootAt on every beat, so each frame must be a
  // no-op. The frames are staggered a second apart on purpose: delivered in one
  // tick, a missing dedupe guard would be unobservable, because re-planning at
  // the same instant yields the same schedule. Staggered, a re-plan would cancel
  // the in-flight chain and jump the count to the last beat.
  const shootAt = 1700000003000;
  const app = loadApp();
  runInContext("state = 'countdown'", app.ctx);
  app.setClock(1700000000000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'READY')[0])})`, app.ctx);
  app.runUntil(1700000001000); // first beat painted; chain armed for the next

  app.setClock(1700000001000);
  runInContext(`planFromCountdown(${JSON.stringify(beats(shootAt, 'READY')[1])})`, app.ctx);
  const painted = app.runUntil(shootAt);
  assert.deepEqual(painted, ['READY', 'KA', 'CHI'], 'duplicate frames do not restart or skip');
  assert.equal(app.count(), 'CHI', 'count settles on the last beat before PUN');
});