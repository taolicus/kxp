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
// The other half of the same path is here too: the stall watchdog that decides
// *whether* a reconnect happens at all. The reconciler tests below pin where a
// reconnected client lands; the watchdog tests at the bottom pin the departure
// -- armed while a game view is live, disarmed when one is not, and above all
// firing in `locked`, where a lost result frame actually strands the round.
// Both live in this file because the watchdog is the reconciler's own trigger:
// its callback closes the stream and calls connect(), whose `connected` handler
// is everything above.

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
const SM = require('./machine.js');

// The stubbed client clock. shootAt/windowMs below are relative to it, so a
// window is "open" or "closed" by arithmetic the test controls outright.
const C = 1700000000000;

// Open window: closes at C + 3000, so it is still open at C.
// Closed window: closes at C - 1000, a second ago by the server's reckoning.
const OPEN = { shootAt: C + 1000, windowMs: 2000 };
const SHUT = { shootAt: C - 3000, windowMs: 2000 };

function connected(d) {
  const app = loadApp();
  // The lobby ships #btn-online in markup; this harness seeds controls on first
  // read, so a test that observes the button must have it present from the start
  // rather than created by the app under test (which would make the assertion
  // race setOnline's own read).
  app.ctx.document.querySelector('#btn-online');
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

  // Invite-first: a lone player creates a code, so an empty lobby no longer
  // gates Play Online. The dot still dims, which is the only thing setOnline
  // touches besides the text. Pinned in the same direction as the fix, so a
  // snapshot that simply stopped calling setOnline would fail the count and dim.
  const empty = connected({ state: 'waiting', online: 0 });
  assert.match(empty.html('#online'), /dim/);
  assert.equal(empty.el('#btn-online').disabled, false, 'joinable even alone');
});

// The stall watchdog. `connected()` above records transitions and runs no enter
// handlers, which is what the reconciler tests want; the watchdog lives in the
// enter handlers and in a timer, so these tests drive the real state machine and
// let the harness fire the timer by advancing the clock.
//
// The id is set on the connection so a trip can post its `stalled` beacon:
// report() drops the beacon when there is no id, which is exactly the state a
// client is in before the first `connected` frame, and a test against that
// client could not tell a working watchdog from a broken one.
function live() {
  const app = loadApp({ next: SM.next });
  runInContext('connect()', app.ctx);
  runInContext("id = 'c1'", app.ctx);
  return app;
}

// 6s after the watchdog is armed, per armStallWatchdog.
const STALL_MS = 6000;

test('the watchdog reconnects a round whose result frame never arrives', () => {
  // The shape the fix exists for, driven the way a real round does it: enter.shoot
  // arms the watchdog, and the local lock timer moves the client to `locked`
  // ~2s later -- long before the 6s budget. A lost result frame leaves the client
  // sitting in `locked`, so `locked` is where the watchdog has to fire. Before
  // the fix the callback declined there and the timer that was meant to rescue
  // the round did nothing.
  const app = live();
  runInContext("state = 'countdown'", app.ctx);
  runInContext(`transition('shoot', { shootAt: ${C + 1000}, windowMs: 2000 })`, app.ctx);
  assert.equal(app.sources.length, 1, 'sanity: one live stream');

  // Past the budget. runUntil fires the lock timer first (to `locked`) and then
  // the watchdog, so the state it sees is the one a stalled round really is in.
  app.setClock(C + STALL_MS);
  app.runUntil(C + STALL_MS + 1);

  assert.equal(app.sources[0].closed, true, 'the stalled stream is dropped');
  assert.equal(app.sources.length, 2, 'a fresh stream replaces it');
  assert.ok(app.posted().includes('/report'), 'a stalled beacon is reported');
});

test('the watchdog fires in every live game state', () => {
  // The polling set, one case per live state. `countdown` and `shoot` already
  // fired before the fix; pinning all three stops the set from being re-derived
  // as a second list that drifts from GAME_STATES.
  for (const state of ['countdown', 'shoot', 'locked']) {
    const app = live();
    runInContext(`state = ${JSON.stringify(state)}; armStallWatchdog()`, app.ctx);
    app.setClock(C + STALL_MS);
    app.runUntil(C + STALL_MS + 1);
    assert.equal(app.sources[0].closed, true, `${state}: stream dropped`);
    assert.equal(app.sources.length, 2, `${state}: reconnected`);
  }
});

test('the watchdog waits the full budget, not a millisecond less', () => {
  // A watchdog that fires early throws a player out of a healthy match, which is
  // worse than not firing at all -- so the boundary is pinned from both sides.
  const app = live();
  runInContext("state = 'shoot'; armStallWatchdog()", app.ctx);

  app.setClock(C + STALL_MS - 1);
  app.runUntil(C + STALL_MS); // fires only what is due strictly before the budget
  assert.equal(app.sources.length, 1, 'one millisecond short is not a stall');

  app.setClock(C + STALL_MS);
  app.runUntil(C + STALL_MS + 1);
  assert.equal(app.sources.length, 2, 'the budget expiring is');
});

test('re-arming resets the single timer rather than stacking a second', () => {
  // The watchdog is a heartbeat, not a pile of timers: arming again has to move
  // the one deadline out. If a second timer stacked, the first would fire at the
  // original budget and trip a match that had just been re-armed.
  const app = live();
  runInContext("state = 'shoot'; armStallWatchdog()", app.ctx);
  app.setClock(C + 3000);
  runInContext('armStallWatchdog()', app.ctx);

  app.setClock(C + STALL_MS);
  app.runUntil(C + STALL_MS + 1);
  assert.equal(app.sources.length, 1, 'the first timer did not survive the re-arm');

  app.setClock(C + 3000 + STALL_MS);
  app.runUntil(C + 3000 + STALL_MS + 1);
  assert.equal(app.sources.length, 2, 'the re-armed timer still fires');
});

test('leaving a round cancels the watchdog, so a later round inherits no timer', () => {
  // The disarm set. A series: round one arms the watchdog and the screen that
  // ends the round clears it, then round two's countdown arrives. If the clear
  // were dropped, round one's timer would still be pending and would force a
  // spurious reconnect in the middle of round two -- a healthy match thrown out
  // by a stale heartbeat.
  for (const [state, ev] of [
    ['lobby', 'stateIdle'],
    ['waiting', 'snapshot:waiting'],
    ['matched', 'snapshot:matched'],
    ['result', 'result'],
  ]) {
    const app = live();
    runInContext("state = 'shoot'; armStallWatchdog()", app.ctx);
    runInContext(`transition(${JSON.stringify(ev)}, {})`, app.ctx);
    // Round two's countdown: a live game state that arms nothing itself, so a
    // surviving timer from round one is the only one that could fire.
    runInContext("transition('snapshot:countdown', {})", app.ctx);

    app.setClock(C + STALL_MS);
    app.runUntil(C + STALL_MS + 1);
    assert.equal(app.sources.length, 1, `${state}: no spurious reconnect`);
    assert.ok(!app.posted().includes('/report'), `${state}: no stalled beacon`);
  }
});

test('a watchdog armed in a round survives a snapshot that reroutes it to countdown', () => {
  // `countdown` is a live game state, so a round whose watchdog is already armed
  // must stay covered when the reconciler routes the client back into it -- a
  // `snapshot:countdown` is exactly how a reconnecting client is put there.
  // Disarming on entry instead would leave the one state the client can be
  // bounced into as the one state the rescue does not cover.
  const app = live();
  runInContext("state = 'countdown'", app.ctx);
  runInContext(`transition('shoot', { shootAt: ${C + 1000}, windowMs: 2000 })`, app.ctx);
  // Let the local lock timer run, then have a snapshot reroute us to countdown.
  app.setClock(C + 3000);
  app.runUntil(C + 3001);
  runInContext("transition('snapshot:countdown', {})", app.ctx);

  app.setClock(C + STALL_MS);
  app.runUntil(C + STALL_MS + 1);
  assert.equal(app.sources[0].closed, true, 'the armed round is still covered');
  assert.equal(app.sources.length, 2, 'reconnected');
});