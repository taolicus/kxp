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

test('planRound: on the KA frame (~2s before PUN) lays out the full schedule', () => {
  const now = 1700000000000;
  const shootAt = now + 2000;
  assert.deepEqual(KXP.planRound(now, shootAt, 2000, 0), {
    msUntilKa: 0, msUntilChi: 1000, msUntilPun: 2000, actionable: true, remainingMs: 4000,
  });
});

test('planRound: skew shifts the whole schedule', () => {
  const now = 1700000000000;
  const shootAt = now + 2000;
  const skew = 500; // server clock 500ms ahead
  assert.deepEqual(KXP.planRound(now, shootAt, 2000, skew), {
    msUntilKa: -500, msUntilChi: 500, msUntilPun: 1500, actionable: true, remainingMs: 3500,
  });
});

test('planRound: announced deadline already passing but window still open', () => {
  const now = 1700000001000; // 1s after the announced PUN
  const shootAt = 1700000000000;
  assert.deepEqual(KXP.planRound(now, shootAt, 2000, 0), {
    msUntilKa: -3000, msUntilChi: -2000, msUntilPun: -1000, actionable: true, remainingMs: 1000,
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

test('planRound: missing plan returns null', () => {
  assert.equal(KXP.planRound(1700000000000, 0, 2000, 0), null);
});

test('planRound: defaults the window when windowMs is absent', () => {
  const now = 1700000000000;
  const p = KXP.planRound(now, now + 1500, 0, 0);
  assert.equal(p.remainingMs, 3500); // 2000 window still fully reachable from now
});

test('applyResult: win bumps wins and streak and raises best', () => {
  assert.deepEqual(KXP.applyResult({ wins: 4, streak: 4, best: 4 }, 'win'), { wins: 5, streak: 5, best: 5 });
});

test('applyResult: win does not lower an existing best', () => {
  assert.deepEqual(KXP.applyResult({ wins: 10, streak: 1, best: 12 }, 'win'), { wins: 11, streak: 2, best: 12 });
});

test('applyResult: loss resets streak but keeps wins and best', () => {
  assert.deepEqual(KXP.applyResult({ wins: 7, streak: 3, best: 8 }, 'loss'), { wins: 7, streak: 0, best: 8 });
});

test('applyResult: draw is a no-op', () => {
  assert.deepEqual(KXP.applyResult({ wins: 7, streak: 3, best: 8 }, 'draw'), { wins: 7, streak: 3, best: 8 });
});

test('applyResult: does not mutate its input', () => {
  const input = { wins: 2, streak: 0, best: 1 };
  KXP.applyResult(input, 'win');
  assert.deepEqual(input, { wins: 2, streak: 0, best: 1 });
});

test('resultLines: timeout note', () => {
  const d = { yourNote: 'timeout', opponent: 'rock' };
  const lines = KXP.resultLines(d);
  assert.equal(lines[0], 'Timed out \u2014 no pick.');
  assert.ok(lines[1].startsWith('Opponent picked:'));
});

test('resultLines: disqualification from an early pick', () => {
  const d = { yourNote: 'early', youTimingMs: -120, opponent: 'scissors' };
  assert.equal(KXP.resultLines(d)[0], 'Disqualified \u2014 120ms early.');
});

test('resultLines: normal pick prefers client-side reaction timestamps', () => {
  const d = {
    you: 'paper', youClientMs: 210, youTimingMs: 480,
    opponent: 'rock', opponentClientMs: 199, opponentTimingMs: 466,
  };
  const lines = KXP.resultLines(d);
  assert.equal(lines[0], 'You picked: \u270b\uFE0F (210ms)');
  assert.equal(lines[1], 'Opponent picked: \u270a\uFE0F (199ms)');
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