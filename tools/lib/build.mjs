// Build identity: which commit is actually answering on the deployed origin.
//
// The probe suite points at a running server, not at a local build, so before
// /health reported a build identity there was no way to tell from the outside
// whether the thing under test was the thing just written. Every live result was
// conditional on an unverifiable assumption — the same failure shape as the probe
// origin quietly defaulting to the wrong host: a green suite measuring the wrong
// target. The suite cannot detect its own misconfiguration, so this check has to.
//
// The expected SHA comes from the local checkout, which is the whole point: "the
// commit I am about to deploy" and "the commit production is serving" are two
// different facts, and comparing them is the only check that catches a failed or
// forgotten restart.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const short = (sha) => (sha && sha.length > 7 ? sha.slice(0, 7) : sha);

// The commit the local checkout says it is on. Throws if git is unavailable or
// the tree is not a work tree — a caller must not treat that as "no mismatch",
// or the check would pass precisely when it could not run.
export function localCommit() {
  const sha = git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git rev-parse HEAD returned ${JSON.stringify(sha)}, want a 40-char sha`);
  return sha;
}

// What production reports, normalised into something comparable.
//
// Returns {sha, modified, source, present}. `present` is false when /health has
// no build object at all — a binary predating this field, which is a real and
// common state (a deploy that never restarted) and must be reported as its own
// outcome rather than folded into a mismatch.
export function remoteBuild(healthJson) {
  const b = healthJson && healthJson.build;
  if (!b || typeof b !== 'object') return { present: false, sha: null, modified: false, source: null };
  return { present: true, sha: b.sha ?? null, modified: b.modified === true, source: b.source ?? null };
}

// Compare production against the local checkout. Returns a verdict object rather
// than throwing, so t1 can report every finding and name the fix.
export function compareBuild(remote, localSha) {
  if (!remote.present) {
    return {
      ok: false,
      reason: 'absent',
      detail: '/health carries no build field — the running binary predates the build-identity change, or the deploy never restarted onto it',
      fix: 'rebuild and restart the service, then re-run t1',
    };
  }
  if (!remote.sha || remote.sha === 'unknown') {
    return {
      ok: false,
      reason: 'unverifiable',
      detail: `production reports sha=${JSON.stringify(remote.sha)} via source=${JSON.stringify(remote.source)}`,
      fix: 'build from the git work tree (go build stamps the revision automatically), or pass -ldflags "-X main.buildSHA=$(git rev-parse HEAD)"',
    };
  }
  if (remote.sha !== localSha) {
    return {
      ok: false,
      reason: 'mismatch',
      detail: `production is running ${short(remote.sha)}, local HEAD is ${short(localSha)}`,
      fix: 'every other probe result is about the other build — rebuild and restart before trusting the suite',
    };
  }
  if (remote.modified) {
    return {
      ok: false,
      reason: 'dirty',
      detail: `production is running ${short(remote.sha)} but reports uncommitted changes in its build tree`,
      fix: 'the deployed binary is not that commit; rebuild from a clean tree',
    };
  }
  return { ok: true, reason: 'match', detail: `${short(remote.sha)} (${remote.source})` };
}
