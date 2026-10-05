// Drives the real web/app.js arcade ladder: the stored run, the draw that starts
// one, the repair that keeps a saved run valid after the roster changes, and the
// opponent a floor asks for.
//
// The draw is random, so nothing here asserts a particular order. What can be
// asserted is the shape of every draw -- every fighter exactly once, the mirror
// last -- since that is the property the ladder depends on, and the exact
// behaviour of a saved order, which is not random at all.
//
// Progression -- what a result does to the floor -- is the other half of the
// ladder, and lives with the result handling it changes.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp, stubElement } = require('./appHarness.cjs');
const SM = require('./machine.js');

const ROSTER = [
  { id: 'dragon', name: 'Dragon', emoji: 'd' },
  { id: 'hielito', name: 'Hielito', emoji: 'h' },
  { id: 'rayito', name: 'Rayito', emoji: 'r' },
  { id: 'robok', name: 'Robok', emoji: 'b' },
];

const IDS = ROSTER.map((c) => c.id);

const text = (app, sel) => app.el(sel).textContent;

// A real state machine, so an SSE frame paints. Without it the client's frames
// are parsed and dropped, and a test of what a frame puts on screen passes for the
// wrong reason: nothing was ever drawn.
const newApp = (opts) => loadApp({ next: SM.next, ...opts });

// The ladder's own fields in the last POST to /cpu. `id` rides on every request
// and is not what these tests are about.
const askedFor = (app) => {
  const hits = app.posts.filter((p) => String(p.url).endsWith('/cpu'));
  assert.ok(hits.length, `nothing was posted to /cpu; posts: ${app.posted().join(', ')}`);
  const b = JSON.parse(hits[hits.length - 1].body);
  return { roundsTarget: b.roundsTarget, opponentCharacter: b.opponentCharacter };
};

// The saved run, read after the client has written it -- which is also why the
// corrupt-run test can seed unreadable JSON: only the client ever reads it.
const saved = (app) => app.saved('kxp-arcade');

// The series-length toggle is a NodeList the harness does not read from markup,
// and it is wired from that list. Which lengths exist is the lobby's business
// (app.lobby.test.cjs pins that); all a ladder test needs is *a* length wired, so
// the floor is fought for real rather than with an unwired 0.
function lengthToggle(app, selected = 3) {
  const btns = [1, 3].map((rounds) => {
    const b = stubElement();
    b.dataset.rounds = String(rounds);
    if (rounds === selected) b.classList.add('selected');
    return b;
  });
  app.seed('#cpu-length .seg-btn', btns);
  app.seed('#cpu-length .seg-btn.selected', btns.find((b) => b.dataset.rounds === String(selected)));
}

async function started(app) {
  lengthToggle(app);
  await app.boot();
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: 'test-client', now: 1700000000000, online: 0 });
}

// Pick a fighter, start a match, and leave the request recorded.
async function fight(app, mode = 'ladder') {
  await app.tap(`#btn-${mode}`);
  await app.tap('#btn-start');
  await app.settle();
}

test('a ladder is the roster shuffled, with the player last, and floor one names its fighter', async () => {
  // Ten draws, because a shuffle that dropped a fighter or left the mirror in the
  // middle is a bug a single draw can hide.
  for (let run = 0; run < 10; run++) {
    const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
    await started(app);
    await fight(app);

    const { order } = saved(app);
    assert.deepStrictEqual([...order].sort(), [...IDS].sort(),
      'a draw must contain every roster fighter exactly once');
    assert.strictEqual(order.length, ROSTER.length, 'a draw must not add or drop floors');
    assert.strictEqual(order[ROSTER.length - 1], 'hielito', 'the mirror match must be last');
    assert.deepStrictEqual(askedFor(app), { roundsTarget: 3, opponentCharacter: order[0] },
      'the request names the fighter standing on this floor');
  }
});

test('the order is drawn, not the roster in the order the server sent it', async () => {
  // The one assertion about randomness, and it is statistical: what is being ruled
  // out is a fixed order, which fails this every single time, whereas a real draw
  // produces varied first floors and varied orders with overwhelming probability
  // -- a fourth-character roster has six possible orders. A test that pinned one
  // exact sequence would need Math.random injected for it, which is a seam added
  // to production code to satisfy a test; this one needs nothing.
  const firsts = new Set();
  const orders = new Set();
  for (let run = 0; run < 12; run++) {
    const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
    await started(app);
    await fight(app);
    const { order } = saved(app);
    orders.add(order.join(','));
    firsts.add(order[0]);
  }
  assert.ok(firsts.size > 1, `every run began on the same floor: ${[...firsts]}`);
  assert.ok(orders.size > 1, `every run drew the same ladder: ${[...orders]}`);
  // "The roster order is never drawn" is deliberately not asserted: this roster has
  // three non-mirror fighters, so the roster's own order is one of the six legal
  // draws and asserting against it would be asserting that the shuffle is wrong.
});

test('the mirror is last whichever fighter the player is', async () => {
  for (const me of IDS) {
    const app = newApp({ roster: ROSTER, store: { 'kxp-character': me } });
    await started(app);
    await fight(app);
    const { order } = saved(app);
    assert.strictEqual(order[order.length - 1], me, `${me} must be the last floor`);
    assert.strictEqual(order.filter((id) => id === me).length, 1, `${me} must appear exactly once`);
  }
});

test('a reload resumes the saved ladder rather than drawing a new one', async () => {
  const first = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(first);
  await fight(first);
  const { order } = saved(first);

  // A second load sharing the store, part-way up. A redraw here is invisible to
  // the player -- they would simply be on a different floor than they left -- so
  // the order itself is compared, not only the floor number on screen.
  const second = newApp({
    roster: ROSTER,
    store: { 'kxp-character': 'hielito', 'kxp-arcade': { order, floor: 2, best: 2 } },
  });
  await started(second);
  assert.match(text(second, '#ladder-info'), /Floor 3 of 4/, 'the lobby resumes the saved floor');
  assert.match(text(second, '#ladder-info'), /Best 2/, 'and remembers the run');

  await fight(second);
  assert.deepStrictEqual(askedFor(second), { roundsTarget: 3, opponentCharacter: order[2] },
    'the resumed floor is the saved one');
  assert.deepStrictEqual(saved(second).order, order, 'and the draw is not repeated');
});

test('a saved order is repaired against a changed roster, keeping its positions', async () => {
  // All three kinds of change at once: hielito removed, nuevo added, and the
  // player's own fighter moved from the middle of the stored order to the end. A
  // repair that handles one and not the others is the shape that breaks on the
  // next roster edit.
  const later = [ROSTER[0], ROSTER[2], ROSTER[3], { id: 'nuevo', name: 'Nuevo', emoji: 'n' }];
  const app = loadApp({
    roster: later,
    store: { 'kxp-arcade': { order: ['robok', 'hielito', 'rayito', 'robok'], floor: 1, best: 1 }, 'kxp-character': 'robok' },
  });
  await started(app);
  await fight(app);

  assert.deepStrictEqual(saved(app).order, ['rayito', 'dragon', 'nuevo', 'robok'],
    'kept fighters hold their order, removed ones go, new ones arrive ahead of the mirror');
  assert.strictEqual(askedFor(app).opponentCharacter, 'dragon',
    'the new fighter is a real floor, and the repair moved the player onto it');
});

test('a floor past the end of a shrunken roster is clamped into range', async () => {
  // Floor 9 of a four-floor ladder. The stored position cannot be honoured, and
  // the request must still name a fighter that exists rather than nothing.
  const app = loadApp({
    roster: ROSTER,
    store: { 'kxp-arcade': { order: IDS, floor: 9, best: 9 }, 'kxp-character': 'hielito' },
  });
  await started(app);
  assert.match(text(app, '#ladder-info'), /Floor 4 of 4/, 'the floor is clamped to the ladder');

  await fight(app);
  assert.strictEqual(askedFor(app).opponentCharacter, 'hielito', 'a clamped ladder fights its last floor');
});

test('a plain CPU match names no opponent, and does not disturb the ladder', async () => {
  // The pin against over-correction: "Play vs CPU" must keep letting the server
  // pick, and must not redraw, advance or overwrite a run in progress. It shares
  // the code path with the ladder, which is what makes this worth asserting.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await fight(app);
  const before = saved(app);

  await fight(app, 'cpu');
  assert.deepStrictEqual(askedFor(app), { roundsTarget: 3, opponentCharacter: undefined },
    'no opponent is named for a plain CPU match, so the server picks');
  assert.deepStrictEqual(saved(app), before, 'the ladder is untouched by another mode');
});

test('the ladder is not offered before the roster arrives', async () => {
  const app = newApp({ roster: [] });
  await started(app);
  assert.strictEqual(text(app, '#ladder-info'), '', 'there is nothing to say without a roster');
  assert.strictEqual(app.el('#btn-ladder').disabled, true, 'the button waits for a roster');
});

test('an unreadable saved run is treated as a first run', async () => {
  // localStorage is user-writable and outlives the code that wrote it, so whatever
  // is in it is untrusted input. Each of these must produce a playable ladder:
  // not an exception, and not a request naming nothing.
  for (const bad of ['{not json', '[]', '{"order":"nope","floor":"x"}', 'null', '{"order":[],"floor":99}']) {
    const app = newApp({ roster: ROSTER, store: { 'kxp-arcade': bad, 'kxp-character': 'hielito' } });
    await started(app);
    await fight(app);

    const { order, floor } = saved(app);
    assert.deepStrictEqual([...order].sort(), [...IDS].sort(), `a ladder is drawn given ${bad}`);
    assert.strictEqual(floor, 0, `and it starts at the bottom given ${bad}`);
    assert.strictEqual(order[ROSTER.length - 1], 'hielito', `with the mirror last given ${bad}`);
    assert.ok(IDS.includes(askedFor(app).opponentCharacter), `and a real fighter is asked for given ${bad}`);
  }
});

test('a roster without the player in it has no mirror floor', async () => {
  // The player's own fighter can be removed from the roster under them. The ladder
  // is then the roster that remains, and the request still has to name a fighter
  // that exists -- otherwise the server refuses it and the mode is dead.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'gone-from-roster' } });
  await started(app);
  await fight(app);

  const { order } = saved(app);
  assert.deepStrictEqual([...order].sort(), [...IDS].sort(), 'the ladder is the roster that remains');
  assert.ok(!order.includes('gone-from-roster'), 'the mirror is only a floor if it is on the roster');
  assert.ok(IDS.includes(askedFor(app).opponentCharacter));
});

test('the floor is announced on the match, then the countdown takes the element', async () => {
  // Which floor this is belongs on screen at the match rather than in a permanent
  // label: the opponent slot already carries the fighter, and the countdown needs
  // that element for its own beats immediately after.
  const app = newApp({ roster: ROSTER, store: { 'kxp-arcade': { order: IDS, floor: 3, best: 3 } } });
  await started(app);
  await fight(app);

  app.fire('matched', { opponentName: 'Hielito', opponentCharacter: 'hielito', roundsTarget: 3 });
  assert.strictEqual(app.count(), 'FLOOR 4');

  app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });
  assert.strictEqual(app.count(), 'READY', 'the countdown overwrites it rather than the two fighting');
});

test('a plain CPU match is not announced as a floor', async () => {
  // The negative direction: same element, same handler, no ladder. The ladder state
  // must not survive the end of the ladder match, or the next CPU match inherits it.
  const app = newApp({ roster: ROSTER, store: { 'kxp-arcade': { order: IDS, floor: 3, best: 3 } } });
  await started(app);
  await fight(app);

  // The ladder match ends: back to the lobby, which clears the in-progress floor.
  app.fire('state', { state: 'lobby' });
  await fight(app, 'cpu');
  app.fire('matched', { opponentName: 'CPU', roundsTarget: 3 });
  assert.strictEqual(app.count(), 'MATCH FOUND');
});

// Progression: what a decided floor does to the run, and what the result screen
// offers next. Everything here is driven by the same real frames the client gets.

const MATCHED = { opponentName: 'Opponent', roundsTarget: 3 };
const series = (over, outcome, wins = 1, losses = 0) => ({
  outcome, mode: 'cpu', round: wins + losses, youRoundWins: wins, oppRoundWins: losses,
  roundsTarget: 3, seriesOver: over,
});

// Climb to `floor` by winning every floor below it, then leave the match that
// would advance past it unplayed. Each floor is a full request -> matched ->
// final result, because that is the sequence a player's floor actually is, and a
// test that only set the store would not notice progress being applied twice.
async function climbTo(app, floor) {
  for (let f = 0; f < floor; f++) {
    await fight(app);
    app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[f] });
    app.fire('result', series(true, 'win'));
  }
}

const ladderLabel = (app) => text(app, '#btn-again');

test('winning a floor advances to the next one', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await fight(app);
  const first = saved(app).order[0];

  app.fire('matched', { ...MATCHED, opponentCharacter: first });
  app.fire('result', series(true, 'win'));

  assert.strictEqual(saved(app).floor, 1, 'one floor higher');
  assert.strictEqual(saved(app).best, 1, 'and one floor cleared');
  assert.strictEqual(saved(app).cleared, false);
  assert.strictEqual(ladderLabel(app), 'Next Floor');

  // The button must ask for the floor it says, not repeat the one just fought.
  await app.tap('#btn-again');
  await app.settle();
  assert.strictEqual(askedFor(app).opponentCharacter, saved(app).order[1],
    'the next floor is a different fighter');
});

test('progress moves on the final result only', async () => {
  // The pin: a mid-series round is not a decided floor. Advancing on one would
  // hand out a floor for a round; restarting on one would drop the player down the
  // ladder mid-series, which is the bug `seriesOver` exists to prevent.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await fight(app);
  app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[0] });

  // Each round is separated by the next round's countdown, as a real series is:
  // the machine drops a result that arrives while already in a result, so firing
  // them back to back would test nothing.
  const nextRound = () => app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });

  app.fire('result', series(false, 'win'));
  assert.strictEqual(saved(app).floor, 0, 'round one of three is not a floor');
  assert.strictEqual(app.el('#btn-again').classList.contains('hidden'), true,
    'and no next floor is offered');
  assert.strictEqual(saved(app).best, 0, 'nor counted as cleared');

  nextRound();
  app.fire('result', series(false, 'loss', 1, 1));
  assert.strictEqual(saved(app).floor, 0, 'nor does losing one restart the ladder');

  nextRound();
  app.fire('result', series(true, 'win', 2, 1));
  assert.strictEqual(saved(app).floor, 1, 'the final result is what moves it');
});

test('losing a floor puts the player back on the first, without redrawing', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, 2);
  const order = saved(app).order;

  const atFloor = saved(app).floor;
  app.fire('matched', { ...MATCHED, opponentCharacter: order[atFloor] });
  app.fire('result', series(true, 'loss'));

  assert.strictEqual(saved(app).floor, 0, 'back to the bottom');
  assert.deepStrictEqual(saved(app).order, order, 'the ladder is the same one -- a loss does not redraw');
  assert.strictEqual(saved(app).best, 2, 'and the high-water mark is not forgotten');
  assert.strictEqual(ladderLabel(app), 'Back to Floor 1');

  await app.tap('#btn-again');
  await app.settle();
  assert.strictEqual(askedFor(app).opponentCharacter, order[0], 'which is where it says it goes');
});

test('a draw counts as not clearing the floor', async () => {
  // A one-round ladder floor can end in a draw -- that was made final deliberately
  // -- so the draw has to land somewhere. Restarting is the honest reading: no
  // floor was cleared.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, 1);
  app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[1] });
  app.fire('result', { outcome: 'draw', mode: 'cpu', roundsTarget: 1, seriesOver: true });

  assert.strictEqual(saved(app).floor, 0, 'the floor is not cleared by a draw');
  assert.strictEqual(saved(app).best, 1, 'and the earlier floor still counts');
});

test('clearing the mirror completes the ladder, and the next request draws a new one', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, ROSTER.length - 1);

  const last = saved(app).order[ROSTER.length - 1];
  assert.strictEqual(last, 'hielito', 'the mirror is what is left to fight');
  app.fire('matched', { ...MATCHED, opponentCharacter: last });
  app.fire('result', series(true, 'win'));

  assert.strictEqual(saved(app).cleared, true, 'the run says it is complete');
  assert.strictEqual(saved(app).best, ROSTER.length, 'with every floor counted');
  assert.strictEqual(ladderLabel(app), 'New Ladder');

  // A cleared run must still be startable -- the player has just beaten the whole
  // ladder and the button cannot dead-end them.
  const doneOrder = saved(app).order;
  await app.tap('#btn-again');
  await app.settle();
  const fresh = saved(app);
  assert.strictEqual(fresh.cleared, false, 'and starts un-cleared');
  assert.strictEqual(fresh.floor, 0, 'from the bottom');
  assert.strictEqual(fresh.best, ROSTER.length, 'keeping the high-water mark');
  assert.strictEqual(askedFor(app).opponentCharacter, fresh.order[0],
    'the new ladder is fought at its first floor');
  assert.notDeepStrictEqual(fresh.order, doneOrder, 'and the order was redrawn');
});

test('a cleared ladder says so in the lobby, and the entry starts a new one', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, ROSTER.length - 1);
  app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[ROSTER.length - 1] });
  app.fire('result', series(true, 'win'));

  // Back to the lobby the only way a player can: the Change mode button.
  await app.tap('#btn-mode');
  assert.match(text(app, '#ladder-info'), /Ladder complete/, 'the lobby reports the completed run');
  assert.strictEqual(app.el('#btn-ladder').textContent, 'New Ladder', 'and the entry says what it does');

  await app.tap('#btn-ladder');
  await app.tap('#btn-start');
  await app.settle();
  assert.strictEqual(saved(app).floor, 0);
  assert.strictEqual(saved(app).cleared, false);
});

test('a plain CPU match is still offered as the same match again', async () => {
  // The over-correction pin. "Play Again" on a non-ladder match must keep its own
  // meaning: a ladder must not leave the button relabelled, or a player who was
  // climbing a floor and then played a normal CPU match would find "Next Floor"
  // pointing at somebody else's ladder.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await fight(app, 'cpu');
  app.fire('matched', { ...MATCHED, opponentName: 'CPU' });
  app.fire('result', { ...series(true, 'win'), mode: 'cpu' });

  assert.strictEqual(ladderLabel(app), 'Play Again', 'a plain CPU match keeps its own button');

  await app.tap('#btn-again');
  await app.settle();
  assert.strictEqual(askedFor(app).opponentCharacter, undefined,
    'and still names no opponent, so it is the same open-ended match again');
});

test('the next floor repeats the length just fought', async () => {
  // The pin from the other side: a player who chose one round on the lobby and
  // changed it mid-ladder must keep fighting one-round floors, or the pips and the
  // rules would disagree.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  lengthToggle(app, 1);
  await started(app);
  await fight(app);
  app.fire('matched', { ...MATCHED, roundsTarget: 1, opponentCharacter: saved(app).order[0] });
  app.fire('result', { ...series(true, 'win'), roundsTarget: 1 });

  // The lobby's selection moves to three while the result is on screen.
  lengthToggle(app, 3);
  await app.tap('#btn-again');
  await app.settle();
  assert.strictEqual(askedFor(app).roundsTarget, 1, 'the next floor is the match that just finished');
});
