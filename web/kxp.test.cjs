const test = require('node:test');
const assert = require('node:assert/strict');
const KXP = require('./kxp.js');

test('shootWindow: no skew, PUN just shown', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at, at, 2000, 2000), { actionable: true, remainingMs: 2000 });
});

test('shootWindow: mid-window', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at + 500, at, 2000, 2000), { actionable: true, remainingMs: 1500 });
});

test('shootWindow: exactly at the deadline is no longer actionable', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at + 2000, at, 2000, 2000), { actionable: false, remainingMs: 0 });
});

test('shootWindow: past the deadline (lag/skew) is not actionable', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at + 2530, at, 2000, 2000), { actionable: false, remainingMs: 0 });
});

test('shootWindow: phone clock ahead of server by ~2s no longer collapses the window', () => {
  const at = 1700000000000;
  const skew = -2000; // serverNow = clientNow - 2000
  assert.deepEqual(KXP.shootWindow(at + 2000, at, 2000, 2000, skew), { actionable: true, remainingMs: 2000 });
});

test('shootWindow: near-window skew still grants the full window', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at + 1900, at, 2000, 2000, -1900), { actionable: true, remainingMs: 2000 });
});

test('shootWindow: skew cancels out, only genuine lag shrinks', () => {
  const at = 1700000000000;
  const skew = -2000;
  assert.deepEqual(KXP.shootWindow(at + 2300, at, 2000, 2000, skew), { actionable: true, remainingMs: 1700 });
  assert.deepEqual(KXP.shootWindow(at + 4000, at, 2000, 2000, skew), { actionable: false, remainingMs: 0 });
});

test('shootWindow: aggressive skew beyond the window clamps to zero', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at + 999999, at, 2000, 2000), { actionable: false, remainingMs: 0 });
});

test('shootWindow: missing timestamps falls back to the full window', () => {
  assert.deepEqual(KXP.shootWindow(1234, 0, 0, 2000), { actionable: true, remainingMs: 2000 });
});

test('shootWindow: reconnect snapshot without windowMs uses the saved fallback', () => {
  const at = 1700000000000;
  assert.deepEqual(KXP.shootWindow(at + 700, at, 0, 1300), { actionable: true, remainingMs: 600 });
});

test('planRound: on the READY frame (3s before PUN) lays out the full schedule', () => {
  const now = 1700000000000;
  const shootAt = now + 3000;
  assert.deepEqual(KXP.planRound(now, shootAt, 2000, 0), {
    msUntilReady: 0, msUntilKa: 1000, msUntilChi: 2000, msUntilPun: 3000,
    dueSlot: 'READY', msUntilNextSlot: 1000, actionable: true, remainingMs: 5000,
  });
});

test('planRound: skew shifts the whole schedule', () => {
  const now = 1700000000000;
  const shootAt = now + 3000;
  const skew = 500; // server clock 500ms ahead
  assert.deepEqual(KXP.planRound(now, shootAt, 2000, skew), {
    msUntilReady: -500, msUntilKa: 500, msUntilChi: 1500, msUntilPun: 2500,
    dueSlot: 'READY', msUntilNextSlot: 500, actionable: true, remainingMs: 4500,
  });
});

test('planRound: announced deadline already passing but window still open', () => {
  const now = 1700000001000; // 1s after the announced PUN
  const shootAt = 1700000000000;
  assert.deepEqual(KXP.planRound(now, shootAt, 2000, 0), {
    msUntilReady: -4000, msUntilKa: -3000, msUntilChi: -2000, msUntilPun: -1000,
    dueSlot: null, msUntilNextSlot: 0, actionable: true, remainingMs: 1000,
  });
});

test('planRound: window already closed is not actionable', () => {
  const now = 1700000002100; // 2.1s after the announced PUN
  const shootAt = 1700000000000;
  const p = KXP.planRound(now, shootAt, 2000, 0);
  assert.equal(p.actionable, false);
  assert.equal(p.remainingMs, 0);
});

test('planRound: exactly at the deadline is no longer actionable', () => {
  const now = 1700000002000;
  const shootAt = 1700000000000;
  assert.equal(KXP.planRound(now, shootAt, 2000, 0).actionable, false);
});

// drive walks a painter the way app.js does: re-check whenever it is told to, and
// advance the clock by however long the painter asked for. The painter and the loop
// must share one clock -- a painter built over a frozen now() cannot be walked.
function drive({ shootAt = 1700000003000, lag = 0 } = {}) {
  let t = shootAt - 3000 + lag;
  const stepper = KXP.countdownPainter(() => t, shootAt, 2000, () => 0);
  const seen = [];
  for (let guard = 0; t < shootAt && guard < 100; guard++) {
    const due = stepper();
    if (due.label) seen.push(due.label);
    if (due.wait <= 0) break;
    t += due.wait;
  }
  return seen;
}

test('countdownPainter: walks every remaining beat, then stops at PUN', () => {
  // The regression that shipped: the client armed a one-shot timer, the later
  // countdown frames were deduped by shootAt, so the walk stopped after the first
  // step. READY painted, KA painted, and CHI never appeared at all -- the count
  // jumped from KA straight to PUN. Every beat that is genuinely still ahead has
  // to be reported, and the walk has to terminate.
  assert.deepEqual(drive(), ['READY', 'KA', 'CHI']);
});

test('countdownPainter: a late first check skips only the beats already gone', () => {
  // Same walk, but the first frame is delayed. Whatever has already passed is
  // dropped, and everything still ahead must still be painted.
  assert.deepEqual(drive({ lag: 0 }), ['READY', 'KA', 'CHI']);
  assert.deepEqual(drive({ lag: 1000 }), ['KA', 'CHI']);
  assert.deepEqual(drive({ lag: 2000 }), ['CHI']);
  assert.deepEqual(drive({ lag: 3000 }), []); // nothing left; PUN opens straight away
});

test('countdownPainter: re-derives, so a wrong clock costs one check not the round', () => {
  // The behaviour that replaced the one-shot chain. A clock reading wrong -- a
  // phone stepping its wall clock between the snapshot and the round -- must not
  // park the display on a single long timer. The wait before the first beat is
  // capped, so the caller re-reads rather than waiting out the bad reading, and
  // the label comes back on the next check.
  const shootAt = 1700000003000;
  let t = 1700000000000 - 4000; // clock reads 4s slow
  const stepper = KXP.countdownPainter(() => t, shootAt, 2000, () => 0);

  const wrong = stepper();
  assert.equal(wrong.label, null, 'nothing is due by the wrong clock');
  assert.ok(wrong.wait > 0 && wrong.wait <= 1000, `wait is capped, got ${wrong.wait}`);

  // The clock steps back to where it should be, and the caller re-checks.
  t = 1700000000000;
  const corrected = stepper();
  assert.equal(corrected.label, 'READY', 'the beat appears once the clock is right');
  assert.equal(corrected.left, 3000, 'and the deadline is intact');
});

test('countdownPainter: reports a label once, not on every check', () => {
  // The caller repaints on a non-null label, so a redundant check or a fresh
  // painter for the same round must not flash the label already on screen.
  const shootAt = 1700000003000;
  let t = 1700000000000;
  const stepper = KXP.countdownPainter(() => t, shootAt, 2000, () => 0);
  assert.equal(stepper().label, 'READY');
  t += 200; // still inside the READY beat
  assert.equal(stepper().label, null, 'no repaint while the beat is unchanged');
  t += 800;
  assert.equal(stepper().label, 'KA');
});

test('countdownPainter: stops once the deadline has long passed', () => {
  // Must not spin: a caller looping on a non-zero wait here would re-arm its timer
  // forever, and PUN would never arrive.
  const stepper = KXP.countdownPainter(() => 1700000000000 + 60000, 1700000000000, 2000, () => 0);
  const due = stepper();
  assert.deepEqual([due.label, due.wait], [null, 0]);
});

test('countdownPainter: skew is read per check, not captured at build time', () => {
  // A client that re-reads its skew mid-round -- every reconnect does -- must not
  // keep counting against the reading it started with.
  const shootAt = 1700000003000;
  let skew = 0;
  let t = 1700000000000;
  const stepper = KXP.countdownPainter(() => t, shootAt, 2000, () => skew);
  assert.equal(stepper().label, 'READY');
  skew = 2000; // the snapshot said the server runs 2s ahead
  assert.equal(stepper().label, 'CHI', 'the corrected skew moves the beat on');
});

test('planRound: missing plan returns null', () => {
  assert.equal(KXP.planRound(1700000000000, 0, 2000, 0), null);
});

test('countdownSlot: reports the beat that is showing at each point on the clock', () => {
  // Offsets are measured back from the announced PUN deadline.
  assert.deepEqual(KXP.countdownSlot(3500), { label: null, msUntilNext: 500 });
  assert.deepEqual(KXP.countdownSlot(3000), { label: 'READY', msUntilNext: 1000 });
  assert.deepEqual(KXP.countdownSlot(2500), { label: 'READY', msUntilNext: 500 });
  assert.deepEqual(KXP.countdownSlot(2000), { label: 'KA', msUntilNext: 1000 });
  assert.deepEqual(KXP.countdownSlot(1000), { label: 'CHI', msUntilNext: 1000 });
  assert.deepEqual(KXP.countdownSlot(500), { label: 'CHI', msUntilNext: 500 });
});

test('countdownSlot: reports no beat at or past the deadline', () => {
  // This is what keeps a late frame from flashing a beat with no time behind it:
  // at the deadline PUN itself is due, so the client paints nothing and opens
  // the window instead of showing a countdown that has already ended.
  assert.deepEqual(KXP.countdownSlot(0), { label: null, msUntilNext: 0 });
  assert.deepEqual(KXP.countdownSlot(-1), { label: null, msUntilNext: 0 });
  assert.deepEqual(KXP.countdownSlot(-5000), { label: null, msUntilNext: 0 });
});

test('countdownSlot: a late first frame still yields a real countdown', () => {
  // The regression: a countdown frame delayed past its own beat used to paint
  // that beat and be overwritten in the same tick, so the player saw no
  // countdown at all. Each delivery lag must instead name the beat that is
  // genuinely showing, until the countdown is genuinely over.
  const shootAt = 1700000000000;
  const at = (lag) => KXP.planRound(shootAt - 3000 + lag, shootAt, 2000, 0);
  assert.equal(at(0).dueSlot, 'READY');
  assert.equal(at(1000).dueSlot, 'KA');
  assert.equal(at(2000).dueSlot, 'CHI');
  assert.equal(at(3000).dueSlot, null);
});

test('planRound: a very late frame leaves the pick window reachable', () => {
  // Even when the whole countdown is eaten, the player still gets to move.
  const shootAt = 1700000000000;
  const p = KXP.planRound(shootAt - 3000 + 2500, shootAt, 2000, 0);
  assert.equal(p.dueSlot, 'CHI');
  assert.equal(p.actionable, true);
  assert.equal(p.remainingMs, 2500);
});

test('planRound: defaults the window when windowMs is absent', () => {
  const now = 1700000000000;
  const p = KXP.planRound(now, now + 1500, 0, 0);
  assert.equal(p.remainingMs, 3500); // 2000 window still fully reachable from now
});

test('applyResult: win bumps wins and streak and raises best', () => {
  assert.deepEqual(
    KXP.applyResult({ wins: 4, streak: 4, best: 4, last: 0 }, 'win'),
    { wins: 5, streak: 5, best: 5, last: 0 },
  );
});

test('applyResult: win does not lower an existing best', () => {
  assert.deepEqual(
    KXP.applyResult({ wins: 10, streak: 1, best: 12, last: 3 }, 'win'),
    { wins: 11, streak: 2, best: 12, last: 3 },
  );
});

test('applyResult: loss records last streak then resets', () => {
  assert.deepEqual(
    KXP.applyResult({ wins: 7, streak: 3, best: 8, last: 2 }, 'loss'),
    { wins: 7, streak: 0, best: 8, last: 3 },
  );
});

test('applyResult: loss on a zero streak does not clobber last', () => {
  assert.deepEqual(
    KXP.applyResult({ wins: 7, streak: 0, best: 8, last: 4 }, 'loss'),
    { wins: 7, streak: 0, best: 8, last: 4 },
  );
});

test('applyResult: draw is a no-op including last', () => {
  assert.deepEqual(
    KXP.applyResult({ wins: 7, streak: 3, best: 8, last: 2 }, 'draw'),
    { wins: 7, streak: 3, best: 8, last: 2 },
  );
});

test('applyResult: does not mutate its input', () => {
  const input = { wins: 2, streak: 0, best: 1, last: 0 };
  KXP.applyResult(input, 'win');
  assert.deepEqual(input, { wins: 2, streak: 0, best: 1, last: 0 });
});

test('resultLines: timeout note', () => {
  const d = { yourNote: 'timeout', opponent: 'rock' };
  const lines = KXP.resultLines(d);
  assert.equal(lines[0], 'Timed out \u2014 no pick.');
  assert.ok(lines[1].startsWith('Them:'));
});

test('resultLines: disqualification from an early pick', () => {
  const d = { yourNote: 'early', youTimingMs: -120, opponent: 'scissors' };
  assert.equal(KXP.resultLines(d)[0], 'Disqualified \u2014 120ms early.');
});

test('resultLines: a pick that landed after the window is not reported as a normal pick', () => {
  // The server sends no timing for an invalid pick, so the else branch would
  // render this as an ordinary scored pick with no reaction time at all --
  // claiming a move counted when the round disqualified it.
  const d = { yourNote: 'late', you: 'rock', opponent: 'scissors' };
  const lines = KXP.resultLines(d);
  assert.equal(lines[0], 'Too late \u2014 the pick window had closed.');
  assert.ok(lines[1].startsWith('Them:'));
});

test('resultLines: normal pick prefers client-side reaction timestamps', () => {
  const d = {
    you: 'paper', youClientMs: 210, youTimingMs: 480,
    opponent: 'rock', opponentClientMs: 199, opponentTimingMs: 466,
  };
  const lines = KXP.resultLines(d);
  assert.equal(lines[0], 'You: \u270b\uFE0F (210ms)');
  assert.equal(lines[1], 'Them: \u270a\uFE0F (199ms)');
});

test('resultLines: empty result yields no lines', () => {
  assert.deepEqual(KXP.resultLines({}), []);
});

test('rejectLabel: maps known server errors', () => {
  assert.equal(KXP.rejectLabel('too early'), 'TOO EARLY!');
  assert.equal(KXP.rejectLabel('too late'), 'TOO LATE!');
  assert.equal(KXP.rejectLabel('move already submitted'), 'ALREADY PICKED');
  assert.equal(KXP.rejectLabel('something else'), 'NOT ACCEPTED');
  assert.equal(KXP.rejectLabel(undefined), 'NOT ACCEPTED');
});

test('beaconGate: first beacon always passes', () => {
  assert.deepEqual(KXP.beaconGate('sse-error', 'shoot', null, 1000), { pass: true, key: 'sse-error|shoot' });
});

test('beaconGate: throttles to one per 5000ms regardless of kind', () => {
  const last = { ms: 1000, key: 'sse-error|shoot' };
  assert.equal(KXP.beaconGate('fetch-error', 'shoot', last, 1000 + 4000).pass, false);
  assert.equal(KXP.beaconGate('fetch-error', 'shoot', last, 1000 + 5000).pass, true);
  const again = { ms: 6000, key: 'fetch-error|shoot' };
  assert.equal(KXP.beaconGate('stalled', 'shoot', again, 10000).pass, false);
});

test('beaconGate: identical kind+state only re-sent after 60s', () => {
  const last = { ms: 1000, key: 'sse-error|shoot' };
  assert.equal(KXP.beaconGate('sse-error', 'shoot', last, 1000 + 30000).pass, false);
  assert.equal(KXP.beaconGate('sse-error', 'shoot', last, 1000 + 59999).pass, false);
  assert.equal(KXP.beaconGate('sse-error', 'shoot', last, 1000 + 60000).pass, true);
});