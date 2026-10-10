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
async function creator(opts = {}) {
  const app = loadApp(Object.assign({ next: (from, ev) => SM.next(from, ev), roster: ROSTER }, opts));
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

// The create side is now the only online entry: Play Online mints a reservation
// and shows its code. The hazard the old form pinned still holds -- the invite
// screen's own entry must not hide the code the create path just filled in --
// but the "plain queue clears a stale code" direction moved to the search
// fallback below, which is now the only way to reach the screen without a
// reservation.

test('Play Online reserves and shows its code on the invite screen', async () => {
  const app = await creator();
  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();
  assert.ok(app.posted().includes('/challenge'), 'the confirm reserves, it does not queue');
  assert.ok(!app.posted().includes('/queue'), 'and does not enter the matchmaker');
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), false,
    'the created link is on screen'
  );
  assert.match(app.el('#challenge-url').value, /challenge=tok/, 'the token reached the link');
});

test('search for anyone cancels the reservation, then queues, and hides the code', async () => {
  const app = await creator();
  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();
  app.tap('#btn-search');
  await app.settle();
  const posted = app.posted();
  const cancelAt = posted.lastIndexOf('/cancel');
  const queueAt = posted.lastIndexOf('/queue');
  assert.ok(cancelAt >= 0, 'the reservation is released');
  assert.ok(queueAt > cancelAt, 'and the queue join lands after it, or the server refuses it');
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), true,
    'no reservation, no code on screen'
  );
});

// The paste half. A full link and a bare token both reduce to the token the
// server minted, because the link is opaque beyond its path.
test('confirming a pasted full link posts /join with its token', async () => {
  const app = await creator();
  app.seed('#claim-url', stubElement());
  app.el('#claim-url').value = 'https://example.test/?challenge=abc123';
  app.tap('#btn-claim');
  await app.settle();
  const join = app.posts.filter((p) => String(p.url).endsWith('/join')).pop();
  assert.ok(join, 'a join was posted');
  assert.equal(JSON.parse(join.body).token, 'abc123');
});

test('confirming a bare pasted token posts /join with it', async () => {
  const app = await creator();
  app.seed('#claim-url', stubElement());
  app.el('#claim-url').value = '  tok9  ';
  app.tap('#btn-claim');
  await app.settle();
  const join = app.posts.filter((p) => String(p.url).endsWith('/join')).pop();
  assert.ok(join, 'a join was posted');
  assert.equal(JSON.parse(join.body).token, 'tok9');
});

test('an empty paste is refused without a request', async () => {
  const app = await creator();
  app.seed('#claim-url', stubElement());
  app.el('#claim-url').value = '';
  app.tap('#btn-claim');
  await app.settle();
  assert.equal(app.posted().filter((p) => p === '/join').length, 0, 'nothing to claim');
});

// A reconnect (or reload) while reserved. The creator's own URL carries no
// token -- only a claimant's does -- so the waiting snapshot is the only thing
// that can put the code back. Without it the client walks to the lobby and the
// shared link vanishes while the reservation is still open.
test('a reconnect carrying the link token rebuilds the invite screen', async () => {
  const app = await creator();
  app.fire('connected', { id: 'c1', state: 'waiting', challenge: 'tok' });
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), false,
    'the link is back'
  );
  assert.match(app.el('#challenge-url').value, /challenge=tok/, 'with its token');
});

test('a plain waiting snapshot shows no code', async () => {
  const app = await creator();
  app.fire('connected', { id: 'c1', state: 'waiting' });
  assert.ok(
    app.el('#challenge-link').classList.contains('hidden'),
    'no code without a token'
  );
});

// Play Again after an online match is a fresh invite, not a rematch of the pair:
// the ended match's reservation is spent, so a new one is minted and the screen
// comes back with a new code, at the length that just played.
test('Play Again mints a fresh invite at the length just played', async () => {
  const app = await creator();
  runInContext("state = 'result'; lastMode = 'online'; lastTarget = 3; lastDrawEnds = false", app.ctx);
  app.tap('#btn-again');
  await app.settle();
  const ch = app.posts.filter((p) => String(p.url).endsWith('/challenge')).pop();
  assert.ok(ch, 'a fresh reservation is minted');
  const body = JSON.parse(ch.body);
  assert.equal(body.roundsTarget, 3, 'at the length just played');
  assert.equal(body.drawEnds, false, 'and its rule');
  assert.equal(
    app.el('#challenge-link').classList.contains('hidden'), false,
    'the new code is on screen'
  );
});

// The share control. On a phone the invite travels through the browser's share
// sheet; everywhere else, and whenever the sheet is dismissed, the URL goes to
// the clipboard instead -- never into the error beacon.

async function withInvite(opts) {
  const app = await creator(opts);
  app.tap('#btn-online');
  app.tap('#btn-start');
  await app.settle();
  return app;
}

test('share hands the invite URL to the Web Share API', async () => {
  const calls = [];
  const app = await withInvite({ share: (d) => { calls.push(d); return Promise.resolve(); } });
  app.tap('#btn-share');
  await app.settle();
  assert.equal(calls.length, 1, 'the sheet was opened once');
  assert.match(calls[0].url, /challenge=tok/, 'with the invite URL');
  assert.deepEqual(app.copies(), [], 'and not copied behind it');
});

test('with no share sheet the share control copies instead', async () => {
  const app = await withInvite();
  assert.ok(app.el('#btn-share').classList.contains('hidden'), 'the Share button is not offered');
  app.tap('#btn-share');
  await app.settle();
  assert.deepEqual(app.copies(), ['copy'], 'it copied the link');
});

test('a dismissed share sheet falls back to copy', async () => {
  const app = await withInvite({ share: () => Promise.reject(new Error('AbortError')) });
  app.tap('#btn-share');
  await app.settle();
  assert.deepEqual(app.copies(), ['copy'], 'the dismissal copied the link, not an error frame');
});
