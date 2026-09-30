// The build-identity check earns its keep only if it actually fails when it
// should. A comparison that always reports a match is worse than no check at
// all: it converts "I cannot tell which build is live" into a confident green,
// which is the exact failure this was added to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remoteBuild, compareBuild } from './build.mjs';

const SHA = '516c03c9f0e1d2b3a4c5d6e7f8091a2b3c4d5e6f';
const OTHER = '933f73b1111111111111111111111111111111111';
const health = (build) => ({ status: 'ok', uptime: 1, build });

test('remoteBuild reports a well-formed stamp', () => {
  assert.deepEqual(remoteBuild(health({ sha: SHA, modified: false, source: 'vcs' })), {
    present: true, sha: SHA, modified: false, source: 'vcs',
  });
});

test('remoteBuild distinguishes absent from present-but-unknown', () => {
  // A binary predating the field and a binary built outside a work tree are
  // different problems with different fixes, so they must not collapse together.
  const absent = remoteBuild({ status: 'ok' });
  assert.equal(absent.present, false);

  const unknown = remoteBuild(health({ sha: 'unknown', modified: false, source: 'unknown' }));
  assert.equal(unknown.present, true);
  assert.equal(unknown.sha, 'unknown');
});

test('remoteBuild survives junk instead of throwing', () => {
  for (const junk of [null, undefined, 'nope', 42, []]) {
    assert.equal(remoteBuild(junk).present, false, `input ${JSON.stringify(junk)}`);
  }
  // A missing sha inside a present object must not read as a match.
  assert.equal(remoteBuild(health({})).sha, null);
});

test('a clean matching stamp passes', () => {
  const v = compareBuild(remoteBuild(health({ sha: SHA, modified: false, source: 'vcs' })), SHA);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'match');
});

test('a build from another commit fails and names both', () => {
  const v = compareBuild(remoteBuild(health({ sha: OTHER, modified: false, source: 'vcs' })), SHA);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'mismatch');
  assert.match(v.detail, /933f73b/);
  assert.match(v.detail, /516c03c/);
  assert.ok(v.fix.length > 0, 'a mismatch must say what to do about it');
});

test('a missing build field fails rather than passing', () => {
  const v = compareBuild(remoteBuild({ status: 'ok' }), SHA);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'absent');
});

test('an unverifiable sha fails and suggests the build flags', () => {
  const v = compareBuild(remoteBuild(health({ sha: 'unknown', modified: false, source: 'unknown' })), SHA);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unverifiable');
  assert.match(v.fix, /ldflags|work tree/);
});

test('a dirty build tree fails even when the sha matches', () => {
  // The sha agreeing is not sufficient: the binary is not that commit if the
  // tree it was built from had uncommitted changes.
  const v = compareBuild(remoteBuild(health({ sha: SHA, modified: true, source: 'vcs' })), SHA);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'dirty');
});

test('prefix-equal shas are not treated as a match', () => {
  // Truncating one side would let a short sha "match" a different commit.
  const v = compareBuild(remoteBuild(health({ sha: SHA.slice(0, 7), modified: false, source: 'vcs' })), SHA);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'mismatch');
});
