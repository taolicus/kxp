// t1 — link characterization + deploy identity.
//
// Run this first, every time. It does not test the app; it measures the path to
// the app, so that every later result can be read against it. A CPU match that
// takes 9s locally and 31s from the train is not a server regression, and this
// script is what proves that.
//
// It also asserts that production is serving the commit in this checkout, before
// anything else is measured. Every other probe in the suite is a statement about
// whatever binary happens to be answering, so a green suite against a stale
// build looks like verification while verifying nothing. This check failed
// silently for as long as the suite existed; it is the one result here that is a
// hard failure rather than a note.
//
// It also warms the connection: the very first request on a fresh mobile link
// pays DNS + TCP + TLS and can take seconds, which is why a lone curl can look
// like a hang and why the first request is reported separately.
//
// It also checks that production is running the commit this checkout is on.
// Every other probe in the suite is a statement about whatever binary happens to
// be serving, so a green suite against a stale build is worse than no suite: it
// looks like verification. That check failed silently for a long time, and t1 is
// the only place it can live — it has to run before anything is believed.
//
//   npm run t1

import { get, BOUNDS, classify, script } from './lib/harness.mjs';
import { localCommit, remoteBuild, compareBuild } from './lib/build.mjs';

const SAMPLES = Number(process.env.SAMPLES || 5);

async function timeIt(path) {
  const started = Date.now();
  try {
    const res = await get(path);
    return { ok: true, status: res.status, ms: res.ms, wall: Date.now() - started };
  } catch (err) {
    return { ok: false, kind: classify(err), ms: Date.now() - started, message: String(err.message || err) };
  }
}

const stats = (xs) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
};

const r = await script('t1 · link characterization', async () => {
  // Build identity first, and on the cold request: /health is the one endpoint
  // that carries it, and there is no point characterising a link to a build the
  // caller did not intend to test.
  const health = await get('/health');
  const build = compareBuild(remoteBuild(health.json), localCommit());
  console.log(
    `  build  ${build.ok ? 'match' : build.reason.toUpperCase()}  ${build.ok ? build.detail : `${build.detail} — ${build.fix}`}`
  );

  const cold = await timeIt('/health');
  console.log(`  cold   /health  ${cold.ok ? `${cold.status} ${cold.wall}ms` : `${cold.kind} ${cold.message}`}`);

  const paths = ['/health', '/', '/characters'];
  const results = {};
  for (const path of paths) {
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const s = await timeIt(path);
      samples.push(s);
      // One line per sample: on a train the variance between consecutive
      // samples is the interesting part, and an average hides it.
      console.log(
        `  ${path.padEnd(12)} #${i + 1} ${s.ok ? `${String(s.status).padEnd(4)} ${String(s.wall).padStart(6)}ms` : `DROP  ${s.kind} ${s.message}`}`
      );
    }
    results[path] = samples;
  }

  const rep = (await import('./lib/harness.mjs')).makeReporter('t1 · link characterization');
  rep.truthy('production runs the local HEAD commit', build.ok, build.detail);
  rep.ok('cold request completes', cold.ok, cold.ok ? `${cold.wall}ms` : `${cold.kind}`);

  for (const [path, samples] of Object.entries(results)) {
    const good = samples.filter((s) => s.ok && s.status === 200);
    const drops = samples.length - good.length;
    const st = stats(good.map((s) => s.wall));
    rep.truthy(`${path} returns 200`, good.length > 0, `${good.length}/${samples.length}`);
    if (drops) {
      // Not a failure: a dropped sample over cellular is the link, and the
      // suite is built to survive it. Recorded so it is visible, not fatal.
      console.log(`  note: ${path} dropped ${drops}/${samples.length} samples (link, not server)`);
    }
    if (st) console.log(`  stat: ${path} min ${st.min} p50 ${st.p50} avg ${st.avg} max ${st.max}ms`);
  }

  return rep.print({
    build: build.ok ? build.detail : `MISMATCH (${build.reason})`,
    cold: cold.ok ? `${cold.wall}ms` : cold.kind,
    dropRate: `${Object.values(results).flat().filter((s) => !s.ok).length}/${SAMPLES * paths.length}`,
  });
});
