// Drives the real web/app.js ready handshake -- the gate between "a match was
// found" and "the countdown starts".
//
// This is load bearing and it used to be automatic. The client posted /ready from
// the end of its matched handler, so the ack proved only that bytes had reached
// the browser. On a phone that means a backgrounded app acknowledged just as
// reliably as one being looked at, and the round then fired at nobody. That is
// the same failure as a late first countdown frame -- a round the player never
// saw coming -- wearing a different cause, which is why it went unfixed: the two
// symptoms look identical from the lobby.
//
// So the ack is now a person saying go, and these tests pin that the client does
// not short-circuit it. The countdown tests already prove the countdown works
// once shootAt is known; nothing else here can see whether the client asked to
// start at all.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp } = require('./appHarness.cjs');
const SM = require('./machine.js');

// matched boots the client, connects, and has the server say a match was found.
async function matched(extra = {}) {
  const app = loadApp({ next: SM.next });
  await app.boot();
  app.fire('connected', { id: 'test-client', now: 1700000000000, online: 0 });
  app.fire('matched', { opponentName: 'Opponent', ...extra });
  return app;
}

const readies = (app) => app.posted().filter((p) => p === '/ready').length;

test('app.js does not acknowledge readiness on its own', async () => {
  // The change this file exists for. Before it, matched() called readyLoop(),
  // which posted /ready immediately -- an ack that cost the player nothing and
  // therefore proved nothing.
  const app = await matched();
  assert.equal(readies(app), 0, 'getting matched must not ack by itself');
});

test('the ready prompt is up while matched', async () => {
  const app = await matched();
  assert.equal(app.el('#btn-ready').classList.contains('hidden'), false,
    'the prompt is offered as soon as a match is found');
  assert.equal(app.count(), 'TAP READY', 'and the count says so');
});

test('tapping ready acknowledges exactly once', async () => {
  const app = await matched();
  app.tap('#btn-ready');
  assert.equal(readies(app), 1, 'one tap is one ack');
  assert.equal(app.el('#btn-ready').disabled, true, 'and the prompt is spent');
  assert.equal(app.count(), 'READY…', 'the count confirms it went');
});

test('a second tap does not re-ack', async () => {
  // The handler re-checks the phase, so a double-tap on a phone cannot turn into
  // two acks and a race with the countdown for no reason.
  const app = await matched();
  app.tap('#btn-ready');
  app.tap('#btn-ready');
  assert.equal(readies(app), 1);
});

test('the prompt comes down when the countdown starts', async () => {
  // The negative direction, and the one that matters for the screen: a prompt
  // left up over a live countdown would sit on top of the count it precedes and
  // could be tapped into the window.
  const app = await matched();
  app.tap('#btn-ready');
  app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });
  assert.equal(app.el('#btn-ready').classList.contains('hidden'), true,
    'no prompt once the countdown is running');
});

test('the prompt comes down when the match ends without a countdown', async () => {
  // The handshake timing out is now a common exit, because a person has to tap,
  // and a prompt left up over the lobby would strand the player on a dead button
  // pointing at a match that no longer exists.
  for (const ev of ['cancel', 'opponentLeft']) {
    const app = await matched();
    assert.equal(app.el('#btn-ready').classList.contains('hidden'), false,
      `prompt is up while matched (${ev})`);
    runInContext(`transition(${JSON.stringify(ev)})`, app.ctx);
    assert.equal(app.el('#btn-ready').classList.contains('hidden'), true,
      `prompt is down after ${ev}`);
  }
});