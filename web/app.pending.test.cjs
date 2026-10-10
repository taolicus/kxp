// Drives the real web/app.js pending-affordance path under test.
//
// A click that awaits a server frame -- Play Online / Instant CPU, the rematch
// button, the tower's fight -- disables its button from the click until the
// screen changes. Left bare the wait reads as inert, and a frame that never
// comes leaves the button dead with no way back. armPending marks it `.pending`
// and arms a single failsafe; clearPending re-arms it when the screen actually
// changes, when the request is refused, or when the failsafe fires.
//
// The clear is tied to show(), not to the transition that decided the move:
// showGame defers the game view behind the background decode, so the choose or
// tower screen is still on screen for the whole download and the button must
// read as working until the swap. Clearing at the transition left it live
// mid-download -- the bug this file now pins.
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

test('a CPU fight keeps its button pending until the screen changes', async () => {
  const app = await client();
  app.tap('#btn-cpu');
  app.tap('#btn-start');
  assert.equal(isPending(app, '#btn-start'), true, 'the wait reads as working');

  // The match screen is gated on the background decoding, so `matched` is
  // decided well before the choose screen is left. The mark must outlast that
  // transition or the button goes live on screen for the whole download.
  app.fire('matched', { opponentName: 'Opponent' });
  assert.equal(isPending(app, '#btn-start'), true, 'still pending while the stage loads');

  app.loadImages();
  await app.settle();
  assert.equal(isPending(app, '#btn-start'), false, 'the screen change re-arms the button');
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
  // clearPending must re-enable what it disabled, not every disabled button: a
  // bystander may be disabled for reasons of its own, and a blanket re-enable
  // would offer a control that cannot work. The waiter is a real pending button,
  // so clearPending definitely runs; the bystander is disabled directly, so the
  // test does not depend on what setOnline does.
  const app = await client();
  app.el('#btn-online').disabled = true;
  app.tap('#btn-cpu');
  app.tap('#btn-start');
  assert.equal(app.el('#btn-start').disabled, true, 'the waiter is pending');
  app.runUntil(Number.MAX_SAFE_INTEGER);
  assert.equal(app.el('#btn-start').disabled, false, 'the failsafe re-arms its own');
  assert.equal(app.el('#btn-online').disabled, true, 'the bystander is left alone');
});
