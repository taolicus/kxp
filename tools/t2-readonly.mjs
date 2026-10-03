// t2 — read-only endpoint contracts.
//
// Checks the three GET endpoints against docs/features/protocol.md:93-106. These are the
// cheapest probes on the server (exempt from rate limiting) and the ones a
// half-restarted deploy breaks first, so this is the right thing to run when
// the app misbehaves and you do not yet know why.
//
// The point is shape, not values: `online` and `uptime` are expected to differ
// every run, but the KEYS must be present and the types must hold. A missing
// `counts` breakdown means a deploy predates the metrics work and the client
// dashboards downstream are reading nothing.
//
//   npm run t2

import { get, BOUNDS, script, makeReporter } from './lib/harness.mjs';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

await script('t2 · read-only endpoint contracts', async () => {
  const rep = makeReporter('t2 · read-only endpoint contracts');
  const latency = {};

  // GET /health — liveness/readiness probe (protocol.md:105)
  const health = await get('/health');
  latency['/health'] = health.ms;
  rep.eq('GET /health status', health.status, 200);
  rep.truthy('health body is an object', isObj(health.json), JSON.stringify(health.json));
  for (const key of ['status', 'uptime', 'online', 'queue', 'activeMatches']) {
    rep.truthy(`health.${key} present`, health.json && key in health.json);
  }
  rep.eq('health.status is ok', health.json?.status, 'ok');
  rep.truthy('health.uptime is numeric', isNum(health.json?.uptime), `${health.json?.uptime}s`);
  for (const key of ['online', 'queue', 'activeMatches']) {
    rep.truthy(`health.${key} is a non-negative int`, Number.isInteger(health.json?.[key]) && health.json[key] >= 0, `${health.json?.[key]}`);
  }

  // GET /characters — the roster is the single source of truth; the client
  // fetches it at startup and bundles no copy (protocol.md:104).
  const chars = await get('/characters');
  latency['/characters'] = chars.ms;
  rep.eq('GET /characters status', chars.status, 200);
  rep.truthy('characters is a non-empty array', Array.isArray(chars.json) && chars.json.length > 0, `${chars.json?.length} entries`);
  const roster = Array.isArray(chars.json) ? chars.json : [];
  const bad = roster.filter((c) => !isObj(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.emoji !== 'string');
  rep.eq('every fighter has {id,name,emoji} strings', bad.length, 0, bad.length ? JSON.stringify(bad[0]) : '');
  const dupes = roster.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
  rep.eq('fighter ids are unique', dupes.length, 0, dupes.join(','));

  // GET /metrics — cumulative counters plus the by* breakdowns (protocol.md:106)
  const metrics = await get('/metrics');
  latency['/metrics'] = metrics.ms;
  rep.eq('GET /metrics status', metrics.status, 200);
  rep.truthy('metrics body is an object', isObj(metrics.json));
  for (const key of ['uptime', 'online', 'queue', 'matches', 'counts']) {
    rep.truthy(`metrics.${key} present`, metrics.json && key in metrics.json);
  }
  rep.truthy('metrics.counts is an object', isObj(metrics.json?.counts));
  for (const key of ['byStatus', 'byCode', 'byMsg', 'byBeaconKind']) {
    rep.truthy(`metrics.counts.${key} present`, isObj(metrics.json?.counts?.[key]), metrics.json?.counts?.[key] ? Object.keys(metrics.json.counts[key]).length + ' keys' : 'MISSING');
  }
  // The beacon breakdown is what proves the client error beacon is landing;
  // if it exists but is always empty, the client's /report calls are failing
  // silently — a bug invisible everywhere else.
  const beacons = metrics.json?.counts?.byBeaconKind || {};
  console.log(`  note: beacons seen: ${Object.keys(beacons).length ? JSON.stringify(beacons) : '(none yet)'}`);

  return rep.print(latency);
});
