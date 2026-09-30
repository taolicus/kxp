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

test('rematch routing after a result', () => {
  assert.strictEqual(next('result', 'matched'), 'matched');
  assert.strictEqual(next('result', 'rematch:online'), 'waiting');
  assert.strictEqual(next('result', 'mode'), 'lobby');
  assert.strictEqual(next('result', 'shoot'), null);
  assert.strictEqual(next('result', 'stateIdle'), null);
  assert.strictEqual(next('countdown', 'matched'), 'countdown');
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