const test = require('node:test');
const assert = require('node:assert');
const { STATES, EVENTS, transitions, next } = require('./machine.js');

test('every declared state and event is defined', () => {
  for (const s of STATES) assert.ok(transitions[s], `missing row for ${s}`);
  for (const ev of EVENTS) {
    let any = false;
    for (const s of STATES) if (Object.hasOwn(transitions[s], ev)) any = true;
    assert.ok(any, `event ${ev} has no transitions at all`);
  }
});

test('unknown pairs return null (silent no-op)', () => {
  assert.strictEqual(next('result', 'stateIdle'), null);
  assert.strictEqual(next('lobby', 'result'), null);
  assert.strictEqual(next('lobby', 'nonsense'), null);
});

test('preserved gameplay transitions', () => {
  assert.strictEqual(next('lobby', 'queue'), 'waiting');
  assert.strictEqual(next('lobby', 'waiting'), 'waiting');
  assert.strictEqual(next('lobby', 'matched'), 'matched');
  assert.strictEqual(next('waiting', 'cancel'), 'lobby');
  assert.strictEqual(next('waiting', 'matched'), 'matched');
  assert.strictEqual(next('waiting', 'stateIdle'), 'lobby');
  assert.strictEqual(next('countdown', 'shoot'), 'shoot');
  assert.strictEqual(next('countdown', 'result'), 'result');
  assert.strictEqual(next('shoot', 'move'), 'locked');
  assert.strictEqual(next('shoot', 'lock'), 'locked');
  assert.strictEqual(next('locked', 'reject'), 'locked');
  assert.strictEqual(next('locked', 'result'), 'result');
});

test('matched = ready-handshake gate before the countdown', () => {
  assert.strictEqual(next('matched', 'countdown'), 'countdown');
  assert.strictEqual(next('matched', 'matched'), 'matched');
  assert.strictEqual(next('matched', 'result'), 'result');
  assert.strictEqual(next('matched', 'opponentLeft'), 'result');
  assert.strictEqual(next('matched', 'cancel'), 'lobby');
  assert.strictEqual(next('matched', 'stateIdle'), 'lobby');
  assert.strictEqual(next('matched', 'shoot'), null);
});

test('a cancelled handshake can put a matched client back in the queue', () => {
  // The server re-queues both sides of a timed-out PvP handshake, so the client
  // that was sitting in the "match found" view is really back in the queue. It
  // needs a direct edge, because routing through stateIdle would drop it into the
  // lobby for a frame — the same silence this edge exists to remove, and a flash
  // of the wrong view on the way.
  assert.strictEqual(next('matched', 'waiting'), 'waiting');
});

test('a series re-enters the countdown from the result state', () => {
  // First to N sends a non-final result and then the next round's countdown
  // frames. Without this edge the frame is dropped as out-of-order: the client
  // sits on the result screen, the round never starts, and the match hangs with
  // the server waiting for a pick that can never be made. Checked here and
  // against the real app.js in app.countdown.test.cjs, because the routing
  // decision and the painting behind it fail differently.
  assert.strictEqual(next('result', 'countdown'), 'countdown');
  // The round still resolves to a result; the new edge must not have displaced
  // that, and a countdown still walks forward to shoot rather than back.
  assert.strictEqual(next('result', 'result'), null);
  assert.strictEqual(next('countdown', 'result'), 'result');
  assert.strictEqual(next('countdown', 'shoot'), 'shoot');
});

test('a forfeit between rounds lands on the result screen it interrupts', () => {
  // The between-rounds gate's forfeit arrives while the player is sitting on
  // the previous round's result panel -- the pause the server takes before the
  // next countdown. Without this edge the frame is dropped as a bad transition
  // and the player never learns the series was awarded to them. It must be the
  // `opponentLeft` event and not a second `result`: the result self-loop stays
  // closed above, because accepting a duplicate result would apply the same
  // round's tally twice.
  assert.strictEqual(next('result', 'opponentLeft'), 'result');
});

test('rematch routing after a result', () => {
  assert.strictEqual(next('result', 'matched'), 'matched');
  assert.strictEqual(next('result', 'rematch:online'), 'waiting');
  assert.strictEqual(next('result', 'mode'), 'lobby');
  assert.strictEqual(next('result', 'shoot'), null);
  assert.strictEqual(next('result', 'stateIdle'), null);
  assert.strictEqual(next('countdown', 'matched'), 'countdown');
});

test('the tower is entered from the result screen and from the picker, and fought back out of it', () => {
  // The screen between ladder floors: the result hands over to it after a floor,
  // and the lobby does from the picker's start button (the picker is not a state,
  // so the machine is still in `lobby` there). The fight it starts comes back as
  // a `matched` frame -- that edge is load-bearing: drop it and the match starts
  // while the client is still on the tower, which then drops the frame as
  // out-of-order and the player watches a countdown that belongs to somebody else.
  assert.strictEqual(next('result', 'climb'), 'ladder');
  assert.strictEqual(next('lobby', 'climb'), 'ladder');
  assert.strictEqual(next('ladder', 'matched'), 'matched');
  assert.strictEqual(next('ladder', 'mode'), 'lobby');
  // Not from anywhere else: the tower is the run's, and a countdown or a shoot
  // reaching it would mean a screen a player never asked for.
  assert.strictEqual(next('countdown', 'climb'), null);
  assert.strictEqual(next('shoot', 'climb'), null);
  assert.strictEqual(next('ladder', 'result'), null);
  // No `stateIdle`: like `result`, the match is already decided by the time this
  // is reachable -- and before a floor it has not started -- so a trailing
  // teardown frame has nothing to reconcile either way in, and routing it to the
  // lobby would walk the player off their own tower.
  assert.strictEqual(next('ladder', 'stateIdle'), null);
});

test('snapshot reconcile is total for every state', () => {
  const targets = { 'snapshot:idle': 'lobby', 'snapshot:waiting': 'waiting', 'snapshot:matched': 'matched', 'snapshot:countdown': 'countdown', 'snapshot:shoot': 'shoot' };
  for (const ev of Object.keys(targets)) {
    for (const s of STATES) {
      assert.strictEqual(next(s, ev), targets[ev], `${s} + ${ev}`);
    }
  }
});

test('invalid absolute moves are unreachable', () => {
  assert.strictEqual(next('result', 'shoot'), null);
  assert.strictEqual(next('shoot', 'countdown'), null);
  assert.strictEqual(next('locked', 'shoot'), null);
  assert.strictEqual(next('waiting', 'again'), null);
});
test('the match history opens from the lobby and is left the way the tower is', () => {
  // The lobby's own screen, opened by its button and closed by `mode` -- the
  // same edge the tower's leave button takes, so leaving it runs the lobby's
  // entry rather than swapping views behind the player's back.
  assert.strictEqual(next('lobby', 'history'), 'history');
  assert.strictEqual(next('history', 'mode'), 'lobby');
  // It yields to a live match the way the lobby does: a frame saying this
  // client is queued or paired wins over the screen it interrupts, and dropping
  // it would leave the player reading a record while a match runs without them.
  assert.strictEqual(next('history', 'waiting'), 'waiting');
  assert.strictEqual(next('history', 'matched'), 'matched');
  // Nowhere else: a round arriving on a record would be a frame out of order,
  // and the record is reachable only from the lobby.
  assert.strictEqual(next('countdown', 'history'), null);
  assert.strictEqual(next('result', 'history'), null);
  assert.strictEqual(next('ladder', 'history'), null);
  assert.strictEqual(next('history', 'countdown'), null);
  // No `stateIdle`, for the reason `result` and `ladder` have none: nothing of
  // a match is live behind it, so a trailing teardown frame has nothing to
  // reconcile, and routing it to the lobby would walk the player out of the
  // record they opened. A reconnect snapshot does cross it, for the reason the
  // two edges above do.
  assert.strictEqual(next('history', 'stateIdle'), null);
  assert.strictEqual(next('history', 'snapshot:matched'), 'matched');
});
