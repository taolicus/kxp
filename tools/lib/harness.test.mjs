// Importing the harness must not need a deployed origin.
//
// `npm run unit` is one of the local gates and runs on a host with no server
// behind it. It broke on exactly that host: harness.mjs resolved the origin at
// module scope, so tools/lib/verdict.test.mjs — which imports only the reporter
// — died as a file ("pass 0, fail 1") behind base.mjs's exit 3, and the gate
// could not be run at all.
//
// The forcing mechanism here is an invalid BASE_URL. It wins over
// tools/.base-url in resolveBase() (base.mjs), so it guarantees a resolution
// would be rejected if one happened — whatever the local file says, which
// matters because the dev host usually has one, so a test that merely unsets
// BASE_URL would prove nothing there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (args) => {
  // NODE_TEST_CONTEXT is set by the parent `node --test`; inherited by the
  // child it makes that child a subtest of the parent and sends its report
  // over IPC rather than to the stdout spawnSync captures, so it is removed.
  const env = { ...process.env, BASE_URL: 'not-a-url' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
};

test('importing the harness does not resolve the origin', () => {
  const r = run(['--input-type=module', '-e', "await import('./tools/lib/harness.mjs')"]);
  assert.equal(r.status, 0, `import must not fail; stderr: ${r.stderr}`);
});

test('the verdict unit tests run with an unusable origin', () => {
  // The regression the laziness fixes: before it, this child exited 3 with
  // "pass 0, fail 1" instead of running a single test body.
  const r = run(['--test', 'tools/lib/verdict.test.mjs']);
  assert.equal(r.status, 0, `unit tests must run without an origin:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /pass\s+[1-9]\d*/, 'the suite must actually run tests');
  assert.match(r.stdout, /fail\s+0/, 'no test may fail');
});

test('a probe still fails loudly at startup on a bad origin', () => {
  // Laziness must not swallow the loud failure. t1 resolves through script()
  // before its first fetch, so an entry point with no usable origin still exits
  // 3 with base.mjs's guidance rather than failing mid-run.
  const r = run(['tools/t1-reach.mjs']);
  assert.equal(r.status, 3, `a probe must exit 3 on a bad origin:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /full http\(s\) origin/, 'the guidance must name the problem');
});
