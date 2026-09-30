// run-all — the whole suite, serially, with one summary.
//
// Serially and without aborting: the tests share a real server and a real rate
// limiter, and a CPU match wants a quiet server (the Playwright config says the
// same thing about workers, playwright.config.cjs:31). One failing script must
// not hide the state of the rest — on a train the first thing you want to know
// is which parts still work.
//
// The summary keeps the three verdicts apart, because they mean different
// things. A FAIL is a defect to go and look at. INCONCLUSIVE is the link, and
// the fix is to re-run when the signal comes back. Silence about that
// distinction is how a suite like this gets ignored.
//
//   npm run tall                    # everything
//   npm run tall -- t5 t6           # only these
//   QUICK=1 npm run tall            # skip the tests that create real matches

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL || 'https://redacted.invalid').replace(/\/+$/, '');

const ALL = [
  { script: 't1-reach.mjs', name: 't1', label: 'link characterization', matches: false, why: 'measures the path, not the app' },
  { script: 't2-readonly.mjs', name: 't2', label: 'read-only contracts', matches: false, why: 'GET only, exempt from rate limiting' },
  { script: 't3-character.mjs', name: 't3', label: 'character round-trip', matches: false, why: 'holds a stream, posts 16 times' },
  { script: 't4-sse.mjs', name: 't4', label: 'SSE stream contract', matches: false, why: 'frames and clock skew, no match' },
  { script: 't5-cpu-match.mjs', name: 't5', label: 'CPU match end-to-end', matches: true, why: 'one real match, the core loop' },
  { script: 't6-reconnect.mjs', name: 't6', label: 'reconnect and reconcile', matches: true, why: 'two real matches, the train case' },
  { script: 't7-move-matrix.mjs', name: 't7', label: 'rejection contract', matches: true, why: 'one real match, every error code' },
  { script: 't8-pvp.mjs', name: 't8', label: 'PvP two clients', matches: true, why: 'two real matches, the asymmetric case' },
];

const wanted = process.argv.slice(2);
const quick = process.env.QUICK === '1';
let plan = wanted.length ? ALL.filter((t) => wanted.includes(t.name)) : ALL;
if (quick) plan = plan.filter((t) => !t.matches);

if (!plan.length) {
  console.error(`no such test. available: ${ALL.map((t) => t.name).join(', ')}`);
  process.exit(1);
}
if (quick && !wanted.length) console.log('QUICK=1 — skipping the match-creating tests\n');

const run = (test) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [join(here, test.script)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    // The child's own verdict is authoritative; the exit code only backs it up.
    const verdict = /RESULT: (PASS|FAIL)/.exec(out)?.[1]
      ?? (/INCONCLUSIVE/.test(out) ? 'INCONCLUSIVE' : 'FAIL');
    const reason = /INCONCLUSIVE \(([^)]*)\)/.exec(out)?.[1] ?? '';
    resolve({ ...test, verdict, reason, secs: ((Date.now() - started) / 1000).toFixed(1) });
  });
});

const results = [];
for (const test of plan) {
  console.log(`\n${'▶'.repeat(3)} ${test.name} · ${test.label}`);
  results.push(await run(test));
}

const MARK = { PASS: 'PASS  ', FAIL: 'FAIL  ', INCONCLUSIVE: 'SKIP  ' };
console.log(`\n${'='.repeat(64)}\nsuite summary  →  ${BASE}${quick ? '  (QUICK)' : ''}\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`  ${MARK[r.verdict]}${r.name}  ${r.label.padEnd(28)} ${r.secs.padStart(5)}s${r.reason ? `  (${r.reason})` : ''}`);
}

const failed = results.filter((r) => r.verdict === 'FAIL');
const skipped = results.filter((r) => r.verdict === 'INCONCLUSIVE');
const passed = results.filter((r) => r.verdict === 'PASS');

console.log(`\n  ${passed.length} passed, ${failed.length} failed, ${skipped.length} inconclusive (link)`);
if (failed.length) {
  console.log(`  FAIL means the server misbehaved — go and read that output.`);
  console.log(`  INCONCLUSIVE means the link dropped — re-run when you have signal.`);
  process.exit(1);
}
if (skipped.length) {
  console.log(`  No failures, but ${skipped.length} could not be judged. Re-run for a clean read.`);
  process.exit(2);
}
console.log(`  Everything passed.`);
