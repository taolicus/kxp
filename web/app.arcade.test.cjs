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
