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

// The screens `show()` toggles, which the harness cannot model from markup it does
// not read. Seeded for every test so a screen can be asserted on directly: that
// the tower is *on screen* is the whole claim of this feature, and inferring it
// from the markup that only exists when it is shown would test the render rather
// than the screen.
function views(app) {
  const lobby = stubElement();
  lobby.id = 'lobby';
  const ladder = stubElement();
  ladder.id = 'ladder';
  app.seed('.view', [lobby, ladder]);
  return { lobby, ladder };
}

const showing = (el) => el.classList.contains('hidden') === false;

// How many matches have been asked for. Counted rather than tested for presence
// because the lobby's own request is one of them: "the tower did not ask for a
// match" is a claim about what changed, not about what exists.
const cpuRequests = (app) => app.posted().filter((p) => p === '/cpu').length;

async function started(app) {
  lengthToggle(app);
  const v = views(app);
  await app.boot();
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: 'test-client', now: 1700000000000, online: 0 });
  return v;
}

// Pick a fighter and start a match, leaving the request recorded. For a ladder
// that is two edges, not one: the picker's start button opens the tower -- the
// mode's first screen is the run, not the match -- and the tower's Fight button
// posts the floor.
async function fight(app, mode = 'ladder') {
  await app.tap(`#btn-${mode}`);
  await app.tap('#btn-start');
  await app.settle();
  if (mode === 'ladder') {
    await app.tap('#ladder-fight');
    await app.settle();
  }
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
  assert.strictEqual(app.el('#ladder-info').classList.contains('hidden'), true,
    'and takes no space while it has nothing to say');
  assert.strictEqual(app.el('#btn-ladder').disabled, true, 'the button waits for a roster');
});

test('the Arcade Mode entry opens on the tower, saving the run before anything is fought', async () => {
  // The mode's first screen is the run, not floor one's match: choosing the mode
  // shows the tower, and the first floor starts from its Fight button. That is
  // also where a first run becomes real -- the tower draws an order the picker's
  // fighter decided, and it must already be in storage when the Fight button
  // posts, or the request would draw a second ladder under the player.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  const view = await started(app);
  await app.tap('#btn-ladder');
  await app.tap('#btn-start');
  await app.settle();

  assert.strictEqual(showing(view.ladder), true, 'the tower is the first screen of the mode');
  assert.strictEqual(showing(view.lobby), false, 'and the lobby is not');
  assert.strictEqual(cpuRequests(app), 0, 'nothing has been asked for yet');
  assert.ok(saved(app), 'the run the tower shows is in storage before the fight');
  assert.deepStrictEqual([...saved(app).order].sort(), [...IDS].sort(),
    'and its order is a real draw, not the roster order');
  assert.strictEqual(towerRows(app)[0].foe, fighter(saved(app).order[0]),
    'the tower draws the stored floor, not a second draw of its own');

  await app.tap('#ladder-fight');
  await app.settle();
  assert.strictEqual(askedFor(app).opponentCharacter, saved(app).order[0],
    'and the first floor is the one the tower showed');
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
// final result -> tower -> fight, because that is the sequence a player's floor
// actually is, and a test that only set the store would not notice progress being
// applied twice. The tower is in the loop rather than skipped because it is how the
// next floor is requested: leaving it out leaves the client's record of which floor
// is in play one floor behind the run, and every later assertion would be reading
// that stale record.
async function climbTo(app, floor) {
  for (let f = 0; f < floor; f++) {
    await fight(app);
    app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[f] });
    app.fire('result', series(true, 'win'));
    await nextFloor(app);
  }
}

const ladderLabel = (app) => text(app, '#btn-again');

// Take the result screen's "next floor" and then the tower's fight button: the two
// taps a player climbing a ladder performs between two floors. Split out because
// every progression test below crosses that gap, and a test that retyped it would
// be testing its own copy of the flow rather than the client's.
async function nextFloor(app) {
  await app.tap('#btn-again');
  await app.settle();
  await app.tap('#ladder-fight');
  await app.settle();
}

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
  await nextFloor(app);
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

  await nextFloor(app);
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
  assert.strictEqual(ladderLabel(app), 'New Arcade Mode');

  // A cleared run must still be startable -- the player has just beaten the whole
  // ladder and the button cannot dead-end them.
  const doneOrder = saved(app).order;
  await nextFloor(app);
  const fresh = saved(app);
  assert.strictEqual(fresh.cleared, false, 'and starts un-cleared');
  assert.strictEqual(fresh.floor, 0, 'from the bottom');
  assert.strictEqual(fresh.best, ROSTER.length, 'keeping the high-water mark');
  assert.strictEqual(askedFor(app).opponentCharacter, fresh.order[0],
    'the new ladder is fought at its first floor');
  assert.notDeepStrictEqual(fresh.order, doneOrder, 'and the order was redrawn');
});

test('a cleared arcade says so in the lobby, and the entry shows it before its restart', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, ROSTER.length - 1);
  app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[ROSTER.length - 1] });
  app.fire('result', series(true, 'win'));

  // Back to the lobby the only way a player can: the Change mode button.
  await app.tap('#btn-mode');
  assert.match(text(app, '#ladder-info'), /Arcade complete/, 'the lobby reports the completed run');
  assert.strictEqual(app.el('#btn-ladder').textContent, 'New Arcade Mode', 'and the entry says what it does');

  await app.tap('#btn-ladder');
  await app.tap('#btn-start');
  await app.settle();
  // The entry only shows the run: a completed ladder enters completed -- its
  // restart is not hers -- so the redraw still belongs to the request.
  assert.strictEqual(saved(app).cleared, true, 'a completed run enters completed');
  assert.strictEqual(text(app, '#ladder-title'), 'Arcade complete');

  await app.tap('#ladder-fight');
  await app.settle();
  assert.strictEqual(saved(app).floor, 0, 'the Fight button draws the next run');
  assert.strictEqual(saved(app).cleared, false);
  assert.strictEqual(askedFor(app).opponentCharacter, saved(app).order[0],
    'and fights its first floor');
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
  assert.ok(!app.html('#ladder-tower'),
    'and it opens no tower -- there is no run to draw one of');
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
  await nextFloor(app);
  assert.strictEqual(askedFor(app).roundsTarget, 1, 'the next floor is the match that just finished');
});

// The tower: the screen between ladder floors.

const fighter = (id) => {
  const c = ROSTER.find((r) => r.id === id);
  assert.ok(c, `${id} must be on the roster to be a floor`);
  return `${c.emoji} ${c.name}`;
};

// The tower's rows, read back off the markup: the floor each row is, the fighter it
// holds, and whether the player is the one standing there. The climb is read as a
// class rather than a position, because the movement is CSS -- the client places
// the player on the final floor and the animation carries them in -- so there is no
// client-side geometry to assert and none that could disagree with the layout.
const ROW = /<div([^>]*)data-floor="(\d+)"([^>]*)>([\s\S]*?)<\/div>/g;

function towerRows(app) {
  return [...String(app.html('#ladder-tower')).matchAll(ROW)].map(([, pre, n, post, body]) => {
    const attrs = pre + post;
    return {
      floor: Number(n),
      foe: (/floor-foe">([^<]*)</.exec(body) || [])[1] || '',
      here: attrs.includes(' here'),
      cleared: attrs.includes(' cleared'),
      hop: (/class="climber ?(climb(?:-down)?)?"/.exec(body) || [])[1] || '',
    };
  });
}

// Play out the floor the run is on -- won, or lost, for the direction that moves --
// then open the tower the way a player does. Returns the floor it was fought on,
// which is what the tower has to have climbed away from.
async function wonFloor(app, outcome = 'win') {
  const floor = saved(app).floor;
  app.fire('matched', { ...MATCHED, opponentCharacter: saved(app).order[floor] });
  app.fire('result', series(true, outcome));
  await app.tap('#btn-again');
  await app.settle();
  return floor;
}

test('a won floor goes through the tower, and the tower asks for nothing by itself', async () => {
  // The flow itself: the result hands over to the tower, and the fight waits for
  // the player. Auto-advancing would put a match on screen underneath an animation
  // that is the whole point of arriving -- the climb has to be somewhere they are
  // looking, not a flash over a result they are still reading.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  const view = await started(app);
  await fight(app);
  const before = cpuRequests(app);

  await wonFloor(app);

  assert.strictEqual(showing(view.ladder), true, 'the tower is the screen between the floors');
  assert.strictEqual(showing(view.lobby), false, 'and the lobby is not');
  assert.strictEqual(cpuRequests(app), before, 'no match is asked for until the player sends for one');
  assert.strictEqual(text(app, '#ladder-title'), 'Floor 2 of 4', 'it says where the player stands');
  assert.strictEqual(text(app, '#ladder-fight'), 'Fight Floor 2', 'and what the button will do');

  await app.tap('#ladder-fight');
  await app.settle();
  assert.strictEqual(askedFor(app).opponentCharacter, saved(app).order[1],
    'the tower fights the floor it names');
});

test('the tower draws every floor, in the order the ladder is fought', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await fight(app);
  const order = saved(app).order;
  await wonFloor(app);

  const rows = towerRows(app);
  assert.deepStrictEqual(rows.map((r) => r.floor), order.map((_, i) => i),
    'the rows are the floors, first floor first');
  assert.deepStrictEqual(rows.map((r) => r.foe), order.map(fighter),
    'each row holds the fighter that floor is fought against, in ladder order');
  // One player on one floor: a tower that drew two would make "where am I" a
  // question, and one that drew none would be a tower nobody is on.
  assert.deepStrictEqual(rows.filter((r) => r.here).map((r) => r.floor), [1]);
  assert.deepStrictEqual(rows.filter((r) => r.cleared).map((r) => r.floor), [0],
    'and the floors below are the ones already beaten');
});

test('winning a floor climbs the player up the tower', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, 2);
  const order = saved(app).order;
  const from = await wonFloor(app);

  const rows = towerRows(app);
  const stood = rows.find((r) => r.here);
  assert.strictEqual(stood.floor, from + 1, 'the player is on the floor the run moved to');
  assert.strictEqual(stood.hop, 'climb', 'arriving from the row below -- one floor of travel');
  assert.strictEqual(stood.foe, fighter(order[from + 1]), 'beside the fighter that floor holds');
  assert.deepStrictEqual(rows.filter((r) => r.cleared).map((r) => r.floor), [0, 1, 2],
    'and everything behind them is a floor that was beaten');
});

test('losing drops the player to the bottom, and the tower shows the drop', async () => {
  // The other direction, which the same code path could get wrong silently: a
  // restart that animated as a climb would tell the player they went up.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, 3);
  await wonFloor(app, 'loss');

  const rows = towerRows(app);
  const stood = rows.find((r) => r.here);
  assert.strictEqual(stood.floor, 0, 'back on the first floor');
  assert.strictEqual(stood.hop, 'climb-down', 'arriving from above');
  assert.deepStrictEqual(rows.filter((r) => r.cleared), [],
    'a lost floor is not a cleared one, so nothing above the player is behind them');
});

test('a completed ladder stands at the top, and its fight draws the next one', async () => {
  // The floor of a cleared run is reset to zero so the lobby would not offer a
  // beaten ladder as a run in progress. The tower is the one place that reset is
  // not the truth, and reading it as "back at the bottom" would finish a run the
  // player just won by dumping them at its first floor.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);
  await climbTo(app, ROSTER.length - 1);
  const doneOrder = saved(app).order;
  await wonFloor(app);

  assert.strictEqual(text(app, '#ladder-title'), 'Arcade complete');
  assert.strictEqual(text(app, '#ladder-fight'), 'New Arcade Mode');
  const stood = towerRows(app).find((r) => r.here);
  assert.strictEqual(stood.floor, ROSTER.length - 1, 'the player is left on the mirror they beat');
  assert.strictEqual(stood.hop, '', 'with nowhere further to climb');

  await app.tap('#ladder-fight');
  await app.settle();
  const fresh = saved(app);
  assert.strictEqual(fresh.cleared, false, 'and the fight starts a fresh run');
  assert.strictEqual(fresh.floor, 0);
  assert.notDeepStrictEqual(fresh.order, doneOrder, 'with a newly drawn order');
  assert.strictEqual(askedFor(app).opponentCharacter, fresh.order[0]);
});

test('the tower can be climbed again, and its fight is not left disarmed', async () => {
  // The fight button disarms itself while its request is in flight, so every visit
  // after the first is a chance for it to arrive still disabled -- and a screen with
  // no way up it is a dead end in the middle of a run.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  const view = await started(app);
  await fight(app);

  await wonFloor(app);
  assert.strictEqual(app.el('#ladder-fight').disabled, false, 'armed when the tower is shown');
  await app.tap('#ladder-fight');
  await app.settle();

  const order = saved(app).order;
  app.fire('matched', { ...MATCHED, opponentCharacter: order[1] });
  app.fire('result', series(true, 'win'));
  await app.tap('#btn-again');
  await app.settle();
  assert.strictEqual(showing(view.ladder), true, 'the second floor is climbed through a tower too');
  assert.strictEqual(app.el('#ladder-fight').disabled, false, 'and its button is armed again');

  await app.tap('#ladder-fight');
  await app.settle();
  assert.strictEqual(askedFor(app).opponentCharacter, order[2], 'so the third floor can be fought');
});

test("the finished match's trailing idle frame does not walk the player off the tower", async () => {
  // The tower is reached from a decided match, so the server's teardown frame is
  // already on its way. Routing it to the lobby -- which is what every other state
  // does with it -- would drop a player standing on their own ladder into the menu
  // with the climb half played and their buttons gone.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  const view = await started(app);
  await fight(app);
  await wonFloor(app);

  app.fire('state', { state: 'idle' });
  await app.settle();

  assert.strictEqual(showing(view.ladder), true, 'the player is still on the tower');
  assert.strictEqual(showing(view.lobby), false, 'not thrown back to the lobby');
  assert.ok(!app.posted().includes('/report'),
    `and the dropped frame is not a client-side anomaly: ${app.posted().join(', ')}`);
  assert.strictEqual(towerRows(app).find((r) => r.here).floor, 1, 'the tower is intact');
});

test('a player can leave the tower without fighting the floor they were on', async () => {
  // The tower is the one screen in a run that is reached on the way somewhere else,
  // so it has to have a way back: the run is persisted, and the lobby resumes it
  // exactly where the tower left it.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  const view = await started(app);
  await fight(app);
  await wonFloor(app);
  const before = cpuRequests(app);

  await app.tap('#ladder-leave');
  await app.settle();

  assert.strictEqual(showing(view.lobby), true, 'back in the lobby');
  assert.strictEqual(showing(view.ladder), false);
  assert.strictEqual(cpuRequests(app), before, 'and no match was started on the way out');
  assert.match(text(app, '#ladder-info'), /Floor 2 of 4/, 'which resumes the floor the tower showed');
});
