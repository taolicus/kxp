// The verdict logic decides whether a run accuses the server or the link, which
// is the whole reason this suite is trustworthy on a moving train. Getting it
// wrong in either direction is costly: a false FAIL gets ignored, and a false
// INCONCLUSIVE hides a real defect. So both directions are pinned here.
//
// The cases that matter came from a real run: t5 recorded
// `/ready accepted = 400 "no active match"` and then timed out waiting for a
// countdown that could never arrive, because the server's 8s readiness gate had
// expired while the ack was in flight.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeReporter, expectReadyAck, classifyThrow } from './harness.mjs';

const res = (status, text) => ({ status, text, json: JSON.parse(text) });

test('a gate expiry is GATE, not a server FAIL', () => {
  const rep = makeReporter('gate');
  expectReadyAck(rep, res(400, '{"error":"no active match"}'));
  assert.equal(rep.gateFailures, 1);
  assert.equal(rep.serverFailures, 0, 'a gate expiry must not count against the server');
  assert.equal(rep.verdict(), 'GATE');
  assert.equal(rep.print({}), false, 'print() must not report success');
});

test('a gate expiry alongside a real failure is still FAIL', () => {
  // The precedence matters: an inconclusive link must never mask a defect found
  // in the same run, or the suite quietly stops catching things.
  const rep = makeReporter('mixed');
  expectReadyAck(rep, res(400, '{"error":"no active match"}'));
  rep.eq('some other check', 1, 2, 'got 1, want 2');
  assert.equal(rep.serverFailures, 1);
  assert.equal(rep.verdict(), 'FAIL');
});

test('a non-gate /ready rejection is an ordinary failure', () => {
  // Only "no active match" means the gate expired. Any other rejection is the
  // server failing to accept a valid ack, and must stay answerable.
  for (const [status, text] of [
    [500, '{"error":"boom"}'],
    [429, '{"error":"rate limited"}'],
    [400, '{"error":"invalid id"}'],
    [409, '{"error":"ready gate closed"}'],
  ]) {
    const rep = makeReporter('notgate');
    expectReadyAck(rep, res(status, text));
    assert.equal(rep.gateFailures, 0, `${status} ${text} must not be treated as a gate expiry`);
    assert.equal(rep.verdict(), 'FAIL');
  }
});

test('an accepted ack passes', () => {
  const rep = makeReporter('ok');
  expectReadyAck(rep, res(200, '{}'));
  assert.equal(rep.passed, 1);
  assert.equal(rep.verdict(), 'PASS');
});

test('verdict precedence is server failure > gate > pass', () => {
  const all = makeReporter('all');
  all.ok('fine', 'x');
  assert.equal(all.verdict(), 'PASS');

  all.gate('gate thing', 'because');
  assert.equal(all.verdict(), 'GATE');

  all.fail('server thing', 'because');
  assert.equal(all.verdict(), 'FAIL');
});

// classifyThrow is the decision that decides whether a run accuses the server or
// the link. Its first version nested the GATE branch inside a condition that
// could only be true when the verdict was FAIL, so a real gate expiry was
// reported as WITHHELD — a contract break against a server that had behaved
// correctly. These pin the precedence directly.

test('a gate expiry is GATE even when a frame was also withheld', () => {
  // The exact live t5 shape: the gate expired, so the countdown never came and
  // the wait timed out. The timeout is a consequence, not a second failure.
  const rep = makeReporter('gate+withheld');
  expectReadyAck(rep, res(400, '{"error":"no active match"}'));
  assert.equal(classifyThrow('WITHHELD', rep), 'GATE');
});

test('a server failure is not softened by a gate expiry in the same run', () => {
  const rep = makeReporter('mixed');
  expectReadyAck(rep, res(400, '{"error":"no active match"}'));
  rep.eq('a real check', 1, 2, 'got 1, want 2');
  assert.equal(classifyThrow('WITHHELD', rep), 'ASSERT');
});

test('withheld with no failed check stays a contract break', () => {
  // The missing-/ready-ack bug WITHHELD was added to catch: every precondition
  // held and the server still withheld. Downgrading this would re-open the exact
  // blind spot that classification exists to close.
  const rep = makeReporter('clean');
  rep.ok('session established', 'abc');
  rep.eq('/ready accepted', 200, 200, '= 200');
  assert.equal(classifyThrow('WITHHELD', rep), 'WITHHELD');
});

test('a withheld frame after an ordinary failed check is that failure', () => {
  const rep = makeReporter('other');
  rep.eq('something unrelated', 400, 200, '= 400 "no active match"');
  assert.equal(classifyThrow('WITHHELD', rep), 'ASSERT');
});

test('a bad HTTP status is never reclassified', () => {
  const rep = makeReporter('server');
  rep.fail('some check', 'nope');
  assert.equal(classifyThrow('SERVER', rep), 'SERVER');
  assert.equal(classifyThrow('NET', rep), 'NET');
  assert.equal(classifyThrow('RATE', rep), 'RATE');
});

test('with no reporter at all the raw kind stands', () => {
  // A script that throws before building a reporter has no evidence either way,
  // so the fault classification must pass through untouched.
  assert.equal(classifyThrow('WITHHELD', null), 'WITHHELD');
  assert.equal(classifyThrow('NET', undefined), 'NET');
});
