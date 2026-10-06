// Drives the real web/app.js lobby: the series length a CPU match is asked for.
//
// The control is a NodeList of buttons that carry their own numbers, so the
// client posts a choice it was shown rather than a literal copy of the rules --
// and a rematch repeats the length the finished match played, not whatever the
// lobby happens to be showing. Both are things only the client can get wrong:
// the server would happily build whatever it was asked for.

const test = require('node:test');
const assert = require('node:assert');

const { runInContext } = require('node:vm');

const { loadApp, stubElement } = require('./appHarness.cjs');
const SM = require('./machine.js');

// The lobby's length toggle as app.js wires it: the buttons, each carrying its
// own number, and the `.selected` selector resolving to whichever is on. The
// harness does not read index.html, so the markup is described here -- and a
// length added to the lobby without a button here fails the test rather than
// silently not being the one that ships. The default tracks the markup: "1
// round" is what a player who never touches the toggle gets.
function lobby(app, { selected = 1, lengths = [1, 3] } = {}) {
  const btns = lengths.map((rounds) => {
    const b = stubElement();
    b.dataset.rounds = String(rounds);
    if (rounds === selected) b.classList.add('selected');
    return b;
  });
  app.seed('#cpu-length .seg-btn', btns);
  app.seed('#cpu-length .seg-btn.selected', btns.find((b) => b.dataset.rounds === String(selected)));
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
  // Default: the option marked selected in the markup is the one posted. If the
  // client defaulted from a literal instead, the two could disagree and the
  // control would be a decoration on the value the server happens to get. The
  // markup's default is "1 round", and the harness default tracks it.
  const app = loadApp({ next: SM.next });
  lobby(app);
  await started(app);

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
});

test('choosing one round is what the server is asked for', async () => {
  const app = loadApp({ next: SM.next });
  const btns = lobby(app, { selected: 3 });
  await started(app);

  // The buttons are wired one by one, so the chosen one is clicked directly --
  // and the wiring is asserted first, so a button that reaches the lobby without
  // a handler fails here rather than looking like a control that does nothing.
  assert.ok(btns[0].handlers.click && btns[1].handlers.click, 'both options are wired');
  btns[0].handlers.click();
  assert.ok(btns[0].classList.contains('selected'), 'the one-round option is now selected');
  assert.ok(!btns[1].classList.contains('selected'), 'and the other is not');

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
});

test('the chosen length is the one a reload starts with', async () => {
  // The toggle is a short-lived choice, but the next lobby visit is not a change
  // of heart: someone who picked first-to-three and comes back after the tab sat
  // for an hour should find it still chosen, not silently offered a one-round
  // match. What is saved is the *number*, not a button, so this is the natural
  // place to pin that restore against the control's own options.
  const app = loadApp({ next: SM.next });
  const btns = lobby(app, { selected: 3 });
  await started(app);

  btns[1].handlers.click();
  assert.ok(btns[1].classList.contains('selected'), 'the first-to-three option is now selected');
  assert.strictEqual(app.saved('kxp-cpu-length'), 3, 'the choice is what gets stored');

  const next = loadApp({ next: SM.next, store: { 'kxp-cpu-length': 3 } });
  const nextBtns = lobby(next, { selected: 1 });
  await started(next);
  assert.ok(nextBtns[1].classList.contains('selected'), 'a reload restores the chosen option');
  assert.ok(!nextBtns[0].classList.contains('selected'), 'and unselects the markup default');

  next.tap('#btn-cpu');
  next.tap('#btn-start');
  await next.settle();

  assert.equal(bodyOf(next, '/cpu').roundsTarget, 3, 'the match is the length of the last visit');
});

test('a stored length the control no longer offers falls back to the default', async () => {
  // The restore is defensive against its own store the way the arcade read is: a
  // value written by hand (or left over from a control that offered other
  // lengths) must not post a length the server has no button for. In the markup
  // the default is "1 round", so that is what a player who never touches the
  // toggle gets, stored junk or not.
  const app = loadApp({ next: SM.next, store: { 'kxp-cpu-length': 2 } });
  lobby(app, { selected: 1 });
  await started(app);

  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
});

test('a rematch repeats the length just played, not the one on screen', async () => {
  // "Play Again" means the same match again. Reading the lobby's current
  // selection instead would silently switch a player who changed it mid-series
  // onto a different kind of game -- and the pips would say one thing while the
  // rules said another.
  const app = loadApp({ next: SM.next });
  lobby(app, { selected: 3 });
  await started(app);
  app.fire('matched', { opponentName: 'CPU', roundsTarget: 1 });
  app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });
  app.fire('result', {
    outcome: 'win', mode: 'cpu', opponentName: 'CPU', round: 1,
    youRoundWins: 1, oppRoundWins: 0, roundsTarget: 1, seriesOver: true,
  });

  app.tap('#btn-again');
  await app.settle();

  assert.equal(bodyOf(app, '/cpu').roundsTarget, 1);
});

test('an online match is not started with a series length', async () => {
  // The pin against over-correction. A PvP match is one round, and it is paired
  // by the queue -- asking for a length there would be a field the server has to
  // ignore, and one a future ready-per-round change could start honouring in the
  // wrong place.
  const app = loadApp({ next: SM.next });
  lobby(app, { selected: 1 });
  await started(app);

  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();

  assert.equal(bodyOf(app, '/queue').roundsTarget, undefined);
});
