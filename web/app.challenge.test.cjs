// Drives the real web/app.js challenge-claim path under test.
//
// A challenge link is claimed by reading `?challenge=` from the URL and posting
// `/join` on `connected`. The hazard this file exists for is that `connected`
// is an SSE (re)connect event, not a once-per-load one: every dropped radio and
// every stall-watchdog trip re-fires it. A claim that runs on each fire posts
// `/join` into a token the server has already consumed, and the player is told
// their own match "expired or is already in play".
//
// `go test` cannot see this (no browser), and the probes verify frames on the
// wire rather than what the client does with a reconnect. So the real app.js is
// run against the shared stubbed context, and the assertions are on the `/join`
// POSTs the client actually made.
//
// The claim is once per page load: `window.__challengeJoined` latches on the
// first attempt and nothing resets it. In particular it must not reset when a
// snapshot stops being `idle` -- the match that follows a successful claim is
// exactly that, and a reset there would let the reconnect after the match
// re-claim the token its own match consumed.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp, stubElement } = require('./appHarness.cjs');
const SM = require('./machine.js');

// A fresh client sitting on `?challenge=<token>`, connected but not yet sent a
// snapshot. `id` is set the way the server's first frame sets it, so the claim
// path runs without the identity-change reconnect a real first frame causes.
function claimant(search) {
  const app = loadApp();
  app.ctx.location.search = search;
  runInContext('connect()', app.ctx);
  runInContext("id = 'c1'", app.ctx);
  return app;
}

const joins = (app) => app.posted().filter((p) => p === '/join').length;

// A client wired for the create path: the real state machine, so entering the
// queue screen runs waiting() instead of being declined, and a roster so the
// lobby has a fighter to draw and the start button is wired. `id` is set the way
// the server's first frame sets it, so post() is not the null short-circuit.
const ROSTER = [{ id: 'aaa', name: 'Aaa', emoji: 'x' }];
async function creator() {
  const app = loadApp({ next: (from, ev) => SM.next(from, ev), roster: ROSTER });
  runInContext("id = 'c1'", app.ctx);
  await app.boot();
  return app;
}

test('an idle snapshot claims the token once', () => {
  const app = claimant('?challenge=tok');
  app.fire('connected', { id: 'c1', state: 'idle' });
  assert.equal(joins(app), 1, 'the claim is posted');
});

test('a reconnect while still waiting does not claim a second time', () => {
  // The common reconnect: SSE dropped before an opponent arrived, so the
  // snapshot is still `idle` with the token in the URL. One claim, not two.
  const app = claimant('?challenge=tok');
  app.fire('connected', { id: 'c1', state: 'idle' });
  app.fire('connected', { id: 'c1', state: 'idle' });
  assert.equal(joins(app), 1, 'still one claim');
});

test('a reconnect after the claim was consumed does not claim again', () => {
  // The hazard in full: the claim built a match, so the next snapshots are not
  // `idle`; when the match ends and a reconnect lands back on idle, the token is
  // still in the URL and already consumed. A latch that resets on the non-idle
  // snapshots re-posts here and tells the player their own match expired.
  const app = claimant('?challenge=tok');
  app.fire('connected', { id: 'c1', state: 'idle' });
  app.fire('connected', { id: 'c1', state: 'ingame', phase: 'countdown' });
  app.fire('connected', { id: 'c1', state: 'idle' });
  assert.equal(joins(app), 1, 'the consumed token is not re-claimed');
});

test('a client with no token never claims', () => {
  const app = claimant('');
  app.fire('connected', { id: 'c1', state: 'idle' });
  assert.equal(joins(app), 0, 'nothing to claim');
});

test('a non-idle first snapshot does not claim, and an idle one later does', () => {
  // A reconnect into a match in progress must not claim; but the token is still
  // unclaimed, so once the client is genuinely idle the claim is still due. The
  // latch only arms on an actual attempt.
  const app = claimant('?challenge=tok');
  app.fire('connected', { id: 'c1', state: 'ingame', phase: 'countdown' });
  assert.equal(joins(app), 0, 'not lobby, not claimed');
  app.fire('connected', { id: 'c1', state: 'idle' });
  assert.equal(joins(app), 1, 'claimed once idle');
});

// The create side. It shares the queue screen with plain matchmaking, and the
// first attempt showed the link and then entered the queue -- whose entry handler
// hid every link it saw, including the one just created. The player saw a bare
// spinner and a dead button. These two tests pin both directions: a created link
// stays up, and a plain queue still clears a link left over from before.

test('creating a challenge leaves its link visible on the queue screen', async () => {
  const app = await creator();
  app.tap('#btn-challenge');
  app.tap('#btn-start');
  await app.settle();
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), false,
    'the created link is on screen'
  );
  assert.match(app.el('#challenge-url').value, /challenge=tok/, 'the token reached the link');
});

test('a plain online queue hides a stale challenge link', async () => {
  const app = await creator();
  // A link left on screen by a previous challenge -- the state a fresh screen
  // does not start in, so the assertion is against the hide, not the default.
  app.seed('#challenge-link', stubElement());
  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), true,
    'the link is not on the queue screen'
  );
});

// A reconnect (or reload) while waiting on a link. The creator's own URL carries
// no token -- only a claimant's does -- so the waiting snapshot is the only
// thing that can put the link back. Without it the client walks to the lobby and
// the shared link vanishes while the challenge is still open.
test('a reconnect carrying the link token rebuilds the queue screen', async () => {
  const app = await creator();
  app.fire('connected', { id: 'c1', state: 'waiting', challenge: 'tok' });
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), false,
    'the link is back'
  );
  assert.match(app.el('#challenge-url').value, /challenge=tok/, 'with its token');
});

test('a plain waiting snapshot shows no challenge link', async () => {
  const app = await creator();
  app.seed('#challenge-link', stubElement());
  app.fire('connected', { id: 'c1', state: 'waiting' });
  assert.ok(
    app.el('#challenge-link').classList.contains('hidden'),
    'no link without a token'
  );
});
