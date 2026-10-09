// Drives the real web/app.js pending-affordance path under test.
//
// A click that awaits a server frame -- Play Online / Instant CPU, the rematch
// button, the tower's fight -- disables its button from the click until an SSE
// frame arrives. Left bare the wait reads as inert, and a frame that never comes
// leaves the button dead with no way back. armPending marks it `.pending` and
// arms a single failsafe; clearPending re-arms it when a frame moves the screen
// on, when the request is refused, or when the failsafe fires.
//
// `go test` cannot see any of this (no browser), and the probes verify frames on
// the wire rather than what a dead button does. So the real app.js runs against
// the shared stubbed context, and the assertions are on the button's class and
// disabled state -- the two things the stylesheet keys the spinner off.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp } = require('./appHarness.cjs');
const SM = require('./machine.js');

const ROSTER = [{ id: 'aaa', name: 'Aaa', emoji: 'x' }];

// A wired client on the lobby with a fighter picked, so the start button exists
// and clicking through to a CPU match posts for real. `id` is set the way the
// server's first frame sets it, because post() short-circuits with no identity;
// the real state machine routes the frames the way the app expects.
async function client(opts = {}) {
  const app = loadApp(Object.assign({ next: SM.next, roster: ROSTER }, opts));
  runInContext("id = 'c1'", app.ctx);
  await app.boot();
  return app;
}

const isPending = (app, sel) => {
  const el = app.el(sel);
  return el.disabled && el.classList.contains('pending');
};

test('a CPU fight marks its button pending until the match frame arrives', async () => {
  const app = await client();
  app.tap('#btn-cpu');
  app.tap('#btn-start');
  assert.equal(isPending(app, '#btn-start'), true, 'the wait reads as working');

  app.fire('matched', { opponentName: 'Opponent' });
  assert.equal(isPending(app, '#btn-start'), false, 'the frame re-arms the button');
  assert.equal(app.el('#btn-start').disabled, false, 'and leaves it clickable');
});

test('a reply that never comes is re-armed by the failsafe', async () => {
  // The bug the failsafe exists for: the POST succeeded, so the client is
  // waiting on an SSE frame that a dropped event never delivers. Without the
  // failsafe the button stays disabled forever and the lobby is a dead end.
  const app = await client();
  app.tap('#btn-cpu');
  app.tap('#btn-start');
  assert.equal(isPending(app, '#btn-start'), true, 'the wait starts');

  app.runUntil(Number.MAX_SAFE_INTEGER);
  assert.equal(isPending(app, '#btn-start'), false, 'the failsafe lets the player retry');
  assert.equal(app.el('#btn-start').disabled, false, 'the button is live again');
});

test('a refused request re-arms the button immediately', async () => {
  const app = await client({ postStatus: 409 });
  app.tap('#btn-cpu');
  app.tap('#btn-start');
  await app.settle();
  assert.equal(isPending(app, '#btn-start'), false, 'a refusal is not a wait');
  assert.equal(app.el('#btn-start').disabled, false, 'the player may ask again');
});

test('the failsafe leaves a button it did not mark alone', async () => {
  // clearPending must re-enable what it disabled, not every disabled button:
  // the online counter disables Play Online for reasons of its own, and a
  // blanket re-enable would offer a button that cannot work.
  const app = await client();
  app.fire('online', { count: 0 });
  assert.equal(app.el('#btn-online').disabled, true, 'no players online');
  app.runUntil(Number.MAX_SAFE_INTEGER);
  assert.equal(app.el('#btn-online').disabled, true, 'and still disabled afterwards');
});
