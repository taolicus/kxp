// t4 — SSE stream contract.
//
// Everything the app does is driven by one long-lived GET /events stream
// (protocol.md:42-60), so the stream itself is the thing most worth probing
// without creating a match. This connects, and checks the first two frames and
// the id-assignment handshake.
//
// The id handshake is the subtle one: a client connecting with no id is given
// one by the server, and the browser client adopts it and reopens (app.js:418).
// A client that kept its own id would orphan its session, and the symptom is
// silent — a stream that delivers frames for a match the client cannot address.
// So this asserts the id the server hands out is the one every later POST must
// use.
//
// Also reports clock skew, because a wrong skew makes the client compute the
// PUN window wrongly (protocol.md:135-144) and the failure looks like "the
// window was too short" rather than a clock bug.
//
// Creates no matches, no POSTs.
//
//   npm run t4

import { Sse, post, get, script, makeReporter, BOUNDS } from './lib/harness.mjs';

await script('t4 · SSE stream contract', async () => {
  const rep = makeReporter('t4 · SSE stream contract');

  const sse = new Sse(); // no id: the server assigns one
  await sse.open();
  rep.truthy('stream opens without an id', true, `${sse.openMs}ms to first byte`);

  const connected = await sse.wait('connected', { timeout: BOUNDS.connect, where: 'handshake' });
  const d = connected.data || {};

  rep.truthy('connected.data is an object', d && typeof d === 'object', JSON.stringify(d));
  rep.truthy('connected.id is a non-empty string', typeof d.id === 'string' && d.id.length > 0, d.id);
  rep.truthy('connected.state is a known state', ['idle', 'waiting', 'ingame'].includes(d.state), d.state);
  rep.truthy('connected.online is a non-negative int', Number.isInteger(d.online) && d.online >= 0, `${d.online}`);
  rep.truthy('connected.now is present (clock skew source)', typeof d.now === 'number', `${d.now}`);

  // The assigned id must be the one the session is actually addressed by.
  rep.truthy('client adopted the server-assigned id', sse.id === d.id, sse.id);
  if (d.id) {
    const roster = (await get('/characters')).json || [];
    const res = await post('/character', { id: d.id, character: roster[0]?.id });
    rep.truthy('a POST addressed to the assigned id is accepted', res.status === 200, `HTTP ${res.status}`);
  }

  // `online` follows the connected snapshot (protocol.md:52).
  const online = await sse.wait('online', { timeout: BOUNDS.connect, from: 1 });
  rep.truthy('online.count is a non-negative int', Number.isInteger(online.data?.count) && online.data.count >= 0, `${online.data?.count}`);

  // The stream must actually stay open and quiet, not close or wedge: the
  // client relies on silence between frames, and a server that closes an idle
  // stream would reconnect-storm on a long train ride.
  const before = sse.frames.length;
  await new Promise((r) => setTimeout(r, 2500));
  const quietHeld = sse.frames.length - before <= 1;
  rep.truthy('stream stays open while idle', !sse.errors.length && quietHeld,
    sse.errors.length ? `error: ${sse.errors[0].message}` : `${sse.frames.length - before} frames in 2.5s idle`);

  // Clock skew: serverNow - clientNow. Over a phone this is normally negative
  // (server ahead). A large positive value means the client's clock is behind
  // and the PUN window will be miscomputed.
  const skew = typeof d.now === 'number' ? d.now - Date.now() : null;
  if (skew !== null) {
    rep.within('clock skew is sane for the PUN window', skew, -60000, 60000);
    console.log(`  note: clock skew server-client = ${skew}ms`);
  }

  sse.drop();
  const types = sse.types();
  rep.truthy('frame order: connected then online', types[0] === 'connected' && types[1] === 'online', types.join(' → '));

  return rep.print({
    open: `${sse.openMs}ms`,
    skew: skew === null ? 'n/a' : `${skew}ms`,
    frames: types.join(' → ') || 'none',
  });
});
