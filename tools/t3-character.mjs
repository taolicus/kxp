// t3 — character selection round-trip.
//
// GET /characters is the source of truth (protocol.md:104) and the client
// fetches it at startup and caches nothing, so the roster and the POST
// validator must agree exactly. This walks the whole roster through
// POST /character and probes the documented edges.
//
// The id must come from a live stream: /character rejects an unknown id with
// 400 "not connected" (server.go:800), so this holds an SSE session open for
// the duration. That ordering matters — the handler validates the character
// first and the connection second (server.go:795,800), so a bogus character on
// a dead id still reports "invalid character".
//
// Creates no matches; ~16 rate-limit tokens.
//
//   npm run t3

import { get, post, Sse, errMsg, script, makeReporter, BOUNDS } from './lib/harness.mjs';

await script('t3 · character round-trip', async () => {
  const rep = makeReporter('t3 · character round-trip');

  const sse = new Sse();
  await sse.open();
  const connected = await sse.wait('connected', { timeout: BOUNDS.connect });
  const id = sse.id || connected.data?.id;
  rep.truthy('have a live session id', Boolean(id), id);
  if (!id) { sse.drop(); return rep.print(); }

  const roster = (await get('/characters')).json || [];
  rep.truthy('roster is non-empty', roster.length > 0, `${roster.length} fighters`);
  if (!roster.length) { sse.drop(); return rep.print(); }

  // Every advertised fighter must be selectable by a connected client.
  const accepted = [];
  let lastFail = null;
  for (const c of roster) {
    const res = await post('/character', { id, character: c.id });
    if (res.status === 200) accepted.push(c.id);
    else lastFail = `${c.id}: HTTP ${res.status} ${errMsg(res)}`;
  }
  rep.eq('every roster fighter is accepted', accepted.length, roster.length, lastFail || `${accepted.length}/${roster.length}`);
  rep.eq('accepted set equals roster exactly', accepted.slice().sort(), roster.map((c) => c.id).slice().sort());

  // Documented rejection, and the message the client surfaces verbatim.
  const bogus = await post('/character', { id, character: 'not-a-fighter' });
  rep.eq('bogus character is rejected', bogus.status, 400);
  rep.eq('rejection message is "invalid character"', errMsg(bogus), 'invalid character');

  // The docs say `character` is required; the server answers "invalid
  // character" for a missing field too, which is the right 400 either way.
  const missing = await post('/character', { id });
  rep.eq('missing character field is rejected', missing.status, 400);
  rep.eq('missing field reports "invalid character"', errMsg(missing), 'invalid character');

  // Malformed types must be refused, never 500: a 500 here would let any
  // client take the deploy down for everyone.
  const wrongType = await post('/character', { id, character: { nested: true } });
  rep.eq('object character is refused with 400', wrongType.status, 400);
  const nullChar = await post('/character', { id, character: null });
  rep.eq('null character is refused with 400', nullChar.status, 400);

  // A dead id proves the session requirement, and doubles as the check that a
  // client whose stream dropped is told so rather than silently accepted.
  const orphan = await post('/character', { id: 't3-never-connected', character: roster[0].id });
  rep.eq('unknown id is refused with 400', orphan.status, 400);
  rep.eq('unknown id reports "not connected"', errMsg(orphan), 'not connected');

  sse.drop();
  return rep.print({ roster: `${roster.length} fighters`, session: id });
});
