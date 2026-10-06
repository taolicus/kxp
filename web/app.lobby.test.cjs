// Drives the real web/app.js lobby: the length and draw rule a CPU match is
// asked for.
//
// The control is a NodeList of buttons that carry their own numbers and the
// draw rule that goes with each, so the client posts a choice it was shown
// rather than a literal copy of the rules -- and a rematch repeats the mode the
// finished match played, length and rule, not whatever the lobby happens to be
// showing. The markup paints no option as selected (the client decides once the
// roster has arrived, so a saved choice cannot flash over the default), so
// these buttons are seeded unselected and the client's own wiring is what
// lights one of them. Both parts are things only the client can get wrong: the
// server would happily build whatever it was asked for.

const test = require('node:test');
const assert = require('node:assert');

const { runInContext } = require('node:vm');

const { loadApp, stubElement } = require('./appHarness.cjs');
const SM = require('./machine.js');

// The lobby's length toggle as app.js wires it: the buttons, each carrying its
// own number and the draw rule that makes it a mode. The harness does not read
// index.html, so the markup is described here -- and a mode added to the lobby
// without a button here fails the test rather than silently not being the one
// that ships. The three options are one round (1-off: a drawn round ends it),
// first to 1, and first to 3; the first two share a length, so the rule is the
// only thing on the wire that tells them apart. No button starts selected; the
// client's default is the first one.
function lobby(app) {
  const btns = [
    [1, 'true'], [1, 'false'], [3, 'false'],
  ].map(([rounds, drawEnds]) => {
    const b = stubElement();
    b.dataset.rounds = String(rounds);
    b.dataset.drawEnds = drawEnds;
    return b;
  });
  app.seed('#cpu-length .seg-btn', btns);
  return btns;
}

// The body of the last POST to `path`, parsed.
const bodyOf = (app, path) => {
  const hits = app.posts.filter((p) => String(p.url).endsWith(path));
  assert.ok(hits.length, `nothing was posted to ${path}; posts: ${app.posted().join(', ')}`);
  return JSON.parse(hits[hits.length - 1].body);
};

async function started(app) {
  await app.boot();
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: 'test-client', now: 1700000000000, online: 0 });
}

test('a CPU match starts at the length the lobby is showing', async () => {
  // The markup paints no selection, so the length a match is asked for is the
  // client's own default: the control's first option, which today is "1 round".
  // If the client defaulted from a literal instead, the two could disagree and
  // the control would be a decoration on the value the server happens to get.
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  assert.ok(btns[0].classList.contains('selected'), 'the client lights the first option itself');
  assert.ok(!btns[1].classList.contains('selected'), 'and the markup default is not the one painted');
  assert.ok(!btns[2].classList.contains('selected'), 'nor is a second one');

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
  assert.strictEqual(bodyOf(app, '/cpu').drawEnds, true, 'and the default sends the rule that ends it');
});

test('choosing one round is what the server is asked for', async () => {
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  // The buttons are wired one by one, so the chosen one is clicked directly --
  // and the wiring is asserted first, so a button that reaches the lobby without
  // a handler fails here rather than looking like a control that does nothing.
  assert.ok(btns[0].handlers.click && btns[1].handlers.click && btns[2].handlers.click,
    'all three options are wired');
  btns[0].handlers.click();
  assert.ok(btns[0].classList.contains('selected'), 'the one-round option is now selected');
  assert.ok(!btns[1].classList.contains('selected') && !btns[2].classList.contains('selected'),
    'and the others are not');

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
  assert.strictEqual(bodyOf(app, '/cpu').drawEnds, true, 'one round ends on its round');
});

test('first-to-1 states its rule, because a length cannot', async () => {
  // The two quick modes share a target, so roundsTarget alone cannot name the
  // match: the server reads drawEnds for the difference, and the control's
  // second segment is where a player asks for it. Sending the field is them
  // asking, not a default the server owns.
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  btns[1].handlers.click();
  assert.ok(btns[1].classList.contains('selected'), 'the first-to-1 option is now selected');
  assert.ok(!btns[0].classList.contains('selected'), 'and the 1-off default is not');

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1, 'the same length as a 1-off');
  assert.strictEqual(bodyOf(app, '/cpu').drawEnds, false, 'but a draw replays until someone wins');
});

test('the chosen mode is the one a reload starts with', async () => {
  // The toggle is a short-lived choice, but the next lobby visit is not a change
  // of heart: someone who picked first-to-three and comes back after the tab sat
  // for an hour should find it still chosen, not silently offered a one-round
  // match. What is saved is the *(length, rule)* pair -- the length still its own
  // number under `kxp-cpu-length`, the rule a `'true'`/`'false'` string under
  // `kxp-cpu-draw-ends` -- not a button, so this is the natural place to pin that
  // restore against the control's own options.
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  btns[2].handlers.click();
  assert.ok(btns[2].classList.contains('selected'), 'the first-to-three option is now selected');
  assert.strictEqual(app.saved('kxp-cpu-length'), 3, 'the choice is what gets stored');
  assert.strictEqual(app.saved('kxp-cpu-draw-ends'), false, 'and the rule that goes with it');

  const next = loadApp({
    next: SM.next,
    store: { 'kxp-cpu-length': 3, 'kxp-cpu-draw-ends': 'false' },
  });
  const nextBtns = lobby(next);
  await started(next);
  assert.ok(nextBtns[2].classList.contains('selected'), 'a reload restores the chosen option');
  assert.ok(!nextBtns[0].classList.contains('selected'), 'and unselects the client default');
  assert.ok(!nextBtns[1].classList.contains('selected'), 'and the mode after it');

  next.tap('#btn-cpu');
  next.tap('#btn-start');
  await next.settle();

  assert.equal(bodyOf(next, '/cpu').roundsTarget, 3, 'the match is the length of the last visit');
  assert.strictEqual(bodyOf(next, '/cpu').drawEnds, false, 'played the mode of the last visit too');
});

test('a store from before the rule still restores by length alone', async () => {
  // The rule key is new, so choices saved before this task are single values: 1
  // meant "1 round" and 3 meant "first to 3". Both must keep their old meaning
  // -- a saved length restoring as a different mode is a silent rule change for
  // a tab that spans the deploy -- so a store without the rule key matches on
  // length and names the old button.
  const old1 = loadApp({ next: SM.next, store: { 'kxp-cpu-length': 1 } });
  const b1 = lobby(old1);
  await started(old1);
  assert.ok(b1[0].classList.contains('selected'), 'a saved one round is still the 1-off button');
  old1.tap('#btn-cpu');
  old1.tap('#btn-start');
  await old1.settle();
  assert.strictEqual(bodyOf(old1, '/cpu').drawEnds, true, 'still played as 1-off');

  const old3 = loadApp({ next: SM.next, store: { 'kxp-cpu-length': 3 } });
  const b3 = lobby(old3);
  await started(old3);
  assert.ok(b3[2].classList.contains('selected'), 'a saved three still means first-to-3');
  old3.tap('#btn-cpu');
  old3.tap('#btn-start');
  await old3.settle();
  assert.strictEqual(bodyOf(old3, '/cpu').drawEnds, false, 'and keeps that mode');
});

test('a saved first-to-1 restores as first-to-1, rule included', async () => {
  // The pair is the mode, so both halves ride the save and the restore: a reload
  // must light first-to-1, not whichever button happens to match the length. A
  // restore that matched on length alone would land on 1-off, and the player
  // would be sold a rule change without having pressed anything.
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  btns[1].handlers.click();
  assert.strictEqual(app.saved('kxp-cpu-length'), 1, 'the length saved is one');
  assert.strictEqual(app.saved('kxp-cpu-draw-ends'), false, 'and the rule saved is the replay one');

  const next = loadApp({
    next: SM.next,
    store: { 'kxp-cpu-length': 1, 'kxp-cpu-draw-ends': 'false' },
  });
  const nextBtns = lobby(next);
  await started(next);
  assert.ok(nextBtns[1].classList.contains('selected'), 'a reload restores first-to-1');
  assert.ok(!nextBtns[0].classList.contains('selected'), 'not the 1-off button that shares its length');

  next.tap('#btn-cpu');
  next.tap('#btn-start');
  await next.settle();
  assert.strictEqual(bodyOf(next, '/cpu').drawEnds, false, 'and plays it as first-to-1 again');
});

test('a stored choice the control no longer offers falls back to the default', async () => {
  // The restore is defensive against its own store the way the arcade read is: a
  // value written by hand (or left over from a control that offered other
  // lengths) must not post a length the server has no button for. The client
  // default is the control's first option, "1 round", so that is what a player
  // who never touches the toggle gets, stored junk or not. The choice is now a
  // pair, so a rule on a length that never carried it counts as junk too.
  const app = loadApp({ next: SM.next, store: { 'kxp-cpu-length': 2 } });
  lobby(app);
  await started(app);

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);

  const pair = loadApp({ next: SM.next, store: { 'kxp-cpu-length': 3, 'kxp-cpu-draw-ends': 'true' } });
  lobby(pair);
  await started(pair);
  pair.tap('#btn-cpu');
  pair.tap('#btn-start');
  await pair.settle();

  assert.equal(bodyOf(pair, '/cpu').roundsTarget, 1, 'the length exists but not under that rule');
  assert.strictEqual(bodyOf(pair, '/cpu').drawEnds, true, 'so the fallback keeps the first option');
});

test('a rematch repeats the match just played, rule included', async () => {
  // "Play Again" means the same match again. First-to-1 and 1-off share a
  // length, so repeating the *length* is not enough to repeat the match: the
  // rule has to come back too, read off the result frame the way lastTarget is.
  // The lobby's default (1-off, drawEnds true) is the wrong answer here, which
  // is what makes the assertion bite.
  const app = loadApp({ next: SM.next });
  lobby(app);
  await started(app);
  app.fire('matched', { opponentName: 'CPU', roundsTarget: 1, drawEnds: false });
  app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });
  app.fire('result', {
    outcome: 'win', mode: 'cpu', opponentName: 'CPU', round: 1,
    youRoundWins: 1, oppRoundWins: 0, roundsTarget: 1, drawEnds: false, seriesOver: true,
  });

  app.tap('#btn-again');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
  assert.strictEqual(bodyOf(app, '/cpu').drawEnds, false, 'the rematch stays first-to-1, not 1-off');
});

test('the choice the lobby is showing rides the queue, not just /cpu', async () => {
  // Flipped from its old form ("an online match is not started with a series
  // length"), whose comment anticipated this very change: the field used to be
  // one the server had to ignore, and a ready-per-round change could start
  // honouring it in the wrong place. The server now honours it in the right
  // place — equal-length pairing — so the control's choice is what the queue
  // is asked for. The default case first: the client's own default, not the
  // markup's, and an explicit field rather than the absent-means-one fallback.
  const app = loadApp({ next: SM.next });
  lobby(app);
  await started(app);

  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/queue').roundsTarget, 1, 'the default length is sent, not omitted');
  assert.strictEqual(bodyOf(app, '/queue').drawEnds, true, 'with the rule that makes it a 1-off');
});

test('choosing first-to-3 online is what the queue is asked for', async () => {
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  btns[2].handlers.click();
  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/queue').roundsTarget, 3, 'the picked length is the match the queue pairs');
  assert.strictEqual(bodyOf(app, '/queue').drawEnds, false, 'and its rule is part of the pairing');
});

test('choosing first-to-1 online is what the queue pairs', async () => {
  // The queue pairs on both fields, so 1-off and first-to-1 are two seats at the
  // same length: a first-to-1 player and a 1-off player waiting together must
  // not be paired as if the modes were the same.
  const app = loadApp({ next: SM.next });
  const btns = lobby(app);
  await started(app);

  btns[1].handlers.click();
  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/queue').roundsTarget, 1, 'pairs on the length');
  assert.strictEqual(bodyOf(app, '/queue').drawEnds, false, 'and on the rule');
});

test('an online rematch queues at the mode just played', async () => {
  // The same rule the CPU branch already follows: "Play Again" means the match
  // that just ended, read off the result frame rather than off the lobby's
  // current selection — with the same older-server fallback for a result that
  // reported no target. The mode has to come back with the length: without the
  // rule, a first-to-1 rematch at a length the selection does not share would
  // come back as the wrong game.
  const app = loadApp({ next: SM.next });
  lobby(app);
  await started(app);

  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();
  app.fire('matched', { opponentName: 'Opponent', roundsTarget: 3, drawEnds: false });
  app.fire('result', {
    mode: 'online', seriesOver: true, outcome: 'win',
    roundsTarget: 3, drawEnds: false, youRoundWins: 3, oppRoundWins: 1,
  });
  app.tap('#btn-again');
  await app.settle();

  assert.equal(bodyOf(app, '/queue').roundsTarget, 3, 'the rematch repeats the series just played');
  assert.strictEqual(bodyOf(app, '/queue').drawEnds, false, 'with the rule it was played under');
});

test('an online rematch of a 1-off that reported no series keeps the lobby 1-off', async () => {
  // A 1-off result omits both series fields (and a pre-series server sends
  // neither to anyone), so there is nothing to repeat: the rematch falls back to
  // the lobby's own choice the way the length already does, and the 1-off
  // inference is what the fallback means — never an invented first-to-1 the
  // match did not have.
  const app = loadApp({ next: SM.next });
  lobby(app);
  await started(app);

  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();
  app.fire('matched', { opponentName: 'Opponent' });
  app.fire('result', { mode: 'online', seriesOver: true, outcome: 'win' });
  app.tap('#btn-again');
  await app.settle();

  assert.equal(bodyOf(app, '/queue').roundsTarget, 1, 'the fallback length is the selection');
  assert.strictEqual(bodyOf(app, '/queue').drawEnds, true, 'and the fallback rule is the 1-off it implied');
});
