// Drives the real web/app.js SSE snapshot reconciler under test.
//
// This is the recovery path. Every stall watchdog trip, every dropped radio and
// every reconnect lands here: app.js:466 reads the `connected` snapshot and
// decides which of five states the client should jump to. Nothing else in this
// repo can see it. `go test` does not run client code, kxp.js tests exercise the
// pure schedule helpers away from app.js, and probes t1-t8 verify frames on the
// wire rather than what the browser does with them. The "stuck after a reconnect"
// symptoms in docs/issues/ all live in exactly this function.
//
// So the shape of the tests is: deliver a synthetic `connected` frame and assert
// which transition the reconciler asked for. The harness records the attempt and
// declines it, so no enter[] painting runs and the decision stands alone.
//
// The three clock-skew tests are the reason this file is worth having. The
// rejoin check is `Date.now() + clockSkew - shootAt >= windowMs`, and getting
// the sign wrong is invisible until a phone with a drifting clock reconnects
// mid-window: it rejoins a window the server has already closed, and the player
// loses a PUN they were still owed.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp } = require('./appHarness.cjs');

// The stubbed client clock. shootAt/windowMs below are relative to it, so a
// window is "open" or "closed" by arithmetic the test controls outright.
const C = 1700000000000;

// Open window: closes at C + 3000, so it is still open at C.
// Closed window: closes at C - 1000, a second ago by the server's reckoning.
const OPEN = { shootAt: C + 1000, windowMs: 2000 };
const SHUT = { shootAt: C - 3000, windowMs: 2000 };

function connected(d) {
  const app = loadApp();
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: null, now: C, ...d });
  return app;
}

// The events the reconciler asked the state machine for, in order.
function routed(app) {
  return app.transitions.map(([, ev]) => ev);
}

test('a snapshot routes to the state that matches where the server thinks we are', () => {
  // The whole routing table, one case per branch at app.js:478-491.
  const cases = [
    ['queued, so back to the queue', { state: 'waiting' }, 'snapshot:waiting'],
    ['match already over, nothing to catch up', { state: 'ingame', phase: 'done' }, 'snapshot:idle'],
    ['between rounds with the gate open, re-admit and re-arm', { state: 'ingame', phase: 'done', pending: true }, 'snapshot:matched'],
    ['handshake still open, re-arm the ack', { state: 'ingame', phase: 'countdown', pending: true }, 'snapshot:matched'],
    ['handshake already settled, resume the count', { state: 'ingame', phase: 'countdown', pending: false }, 'snapshot:countdown'],
    ['PUN window still open', { state: 'ingame', phase: 'shoot', ...OPEN }, 'snapshot:shoot'],
    ['PUN window already closed', { state: 'ingame', phase: 'shoot', ...SHUT }, 'snapshot:idle'],
    ['no match to rejoin', { state: 'lobby' }, 'snapshot:idle'],
    ['snapshot with no state at all', {}, 'snapshot:idle'],
  ];
  for (const [what, d, want] of cases) {
    assert.deepEqual(routed(connected(d)), [want], what);
  }
});

test('a shoot snapshot missing its timing fields does not fall through to idle', () => {
  // `d.shootAt && d.windowMs` guards the window check. Without the guard the
  // comparison would run against undefined and -- whatever the intent -- a
  // half-formed shoot frame would either strand the player on the lobby or, once
  // windowMs arrives in a later deploy, change routing without any test failing.
  // Both cases must stay on the shoot view: there is a window, we just cannot
  // prove it closed.
  for (const d of [
    { state: 'ingame', phase: 'shoot', windowMs: 2000 },
    { state: 'ingame', phase: 'shoot', shootAt: C + 1000 },
  ]) {
    assert.deepEqual(routed(connected(d)), ['snapshot:shoot'], JSON.stringify(d));
  }
});

test('the rejoin window is judged on server time, not the phone clock', () => {
  // Identical shootAt and windowMs in all three cases; only the snapshot's `now`
  // differs, so only clockSkew can move the outcome. The window closes at C+3000
  // of server time, which is exactly why a client that trusted its own clock
  // would get this wrong: at C it reads as comfortably open.
  const win = { state: 'ingame', phase: 'shoot', ...OPEN };

  // Server agrees with us: the window has not closed. Rejoin it.
  assert.deepEqual(routed(connected({ ...win, now: C })), ['snapshot:shoot'], 'no skew');

  // Server clock runs 5s ahead: the window closed 2s ago on the server. Rejoining
  // it would hand the player a PUN that cannot score, so we must go idle.
  assert.deepEqual(routed(connected({ ...win, now: C + 5000 })), ['snapshot:idle'], 'server ahead');

  // Server runs 3s behind: the window is still open and we were owed it. The sign
  // of clockSkew matters here -- reading it backwards sends a player who is still
  // owed a PUN to the lobby.
  assert.deepEqual(routed(connected({ ...win, now: C - 3000 })), ['snapshot:shoot'], 'server behind');
});

test('the window shuts at the instant it expires, not one millisecond later', () => {
  // Exactly on the boundary: elapsed === windowMs. The window is playable up to
  // and including shootAt + windowMs, so `>` here would leave a client a single
  // millisecond of dead PUN -- and one millisecond is all the gap the probe suite
  // would ever see, since nothing else checks this arithmetic.
  const exact = { state: 'ingame', phase: 'shoot', shootAt: C - 2000, windowMs: 2000, now: C };
  assert.deepEqual(routed(connected(exact)), ['snapshot:idle'], 'elapsed === windowMs');

  // One millisecond earlier it is still open. The pair is what makes the boundary
  // a boundary rather than a threshold that happens to be loose.
  assert.deepEqual(routed(connected({ ...exact, shootAt: C - 1999 })), ['snapshot:shoot'], 'elapsed < windowMs');
});

test('an id change reconnects instead of reconciling against a stale identity', () => {
  // The server assigns an id on the first connect. The client has none, sees the
  // mismatch, drops the stream and reconnects carrying it -- and must not also
  // route the pre-id snapshot, or a client with an id change mid-match would
  // reconcile a frame meant for a different connection.
  const app = loadApp();
  runInContext('connect()', app.ctx);
  assert.equal(app.sources.length, 1);

  app.fire('connected', { id: 'abc', state: 'ingame', phase: 'shoot', ...OPEN });
  assert.equal(app.sources[0].closed, true, 'stale stream closed');
  assert.equal(app.sources.length, 2, 'reconnected');
  assert.deepEqual(routed(app), [], 'no transition on an identity change');

  // The new connection matches, so the same snapshot now reconciles. This is what
  // stops the mismatch from looping forever.
  app.fire('connected', { id: 'abc', state: 'ingame', phase: 'shoot', ...OPEN });
  assert.deepEqual(routed(app), ['snapshot:shoot']);
});

test('a snapshot refreshes the online count without waiting for the next event', () => {
  // The only field the handler applies unconditionally. It is also the field a
  // stalled connection stops delivering, so the snapshot is the only thing that
  // can un-stick a stale count.
  const busy = connected({ state: 'waiting', online: 7 });
  assert.match(busy.html('#online'), /7 online now/);
  assert.equal(busy.el('#btn-online').disabled, false, 'joinable while others are around');

  // The other half of the same branch: nobody in the lobby means the button is
  // dead, and the dot dims. Pinned in the same direction as the fix, so a
  // snapshot that simply stopped calling setOnline would fail both.
  const empty = connected({ state: 'waiting', online: 0 });
  assert.match(empty.html('#online'), /dim/);
  assert.equal(empty.el('#btn-online').disabled, true, 'not joinable alone');
});