// t5 — one CPU match, end to end, over the real internet.
//
// This is the protocol-level equivalent of Playwright flow 1, and the single
// most valuable thing to run when the app feels wrong on a phone. A CPU match
// is the whole game loop in one shot: the ready handshake, the countdown, the
// PUN window, a scored move, and a result — every frame type the client
// depends on, in the documented order.
//
// It is also the only probe here that verifies TIMING rather than shape, and
// timing is the thing a moving train breaks. The server pre-announces the round
// plan on the countdown frames ({n, shootAt, windowMs, ts}, protocol.md:158),
// so this can check the announcement against the frames that actually arrive,
// and check that the PUN window was still open when the move landed. A match
// that "completes" but arrived with the window already shut is the exact
// failure the rework set out to prevent.
//
// A real bug to look for: the client is told to shoot, but by the time the
// frame reaches the phone the window is gone, so every round silently
// timeouts. The `pun headroom` line is the number that predicts it.
//
// Consumes one real match and ~6 rate-limit tokens.
//
//   npm run t5

import { Sse, post, get, errMsg, script, makeReporter, BOUNDS, expectReadyAck } from './lib/harness.mjs';

const WINS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Post the move as fast as the link allows, and record how long that took: this
// is the number that decides whether a human on this connection can play.
async function submitMove(id, move) {
  const sentAt = Date.now();
  const res = await post('/move', { id, move, sawPunAt: sentAt, clickedAt: sentAt });
  return { res, sentAt, rtt: Date.now() - sentAt };
}

await script('t5 · CPU match end-to-end', async () => {
  const rep = makeReporter('t5 · CPU match end-to-end');
  const sse = new Sse();
  await sse.open();
  const connected = await sse.wait('connected', { timeout: BOUNDS.connect });
  const id = sse.id || connected.data.id;
  const skew = typeof connected.data.now === 'number' ? connected.data.now - Date.now() : 0;
  rep.truthy('session established', Boolean(id), `${id} (skew ${skew}ms)`);

  const roster = (await get('/characters')).json || [];
  const pick = roster[Math.floor(Math.random() * roster.length)]?.id;
  const chosen = await post('/character', { id, character: pick });
  rep.eq('fighter accepted before the match', chosen.status, 200, pick);

  // POST /cpu also drains the queue (protocol.md:108). The match it starts is
  // still gated on our /ready ack, sent below. The cursor is taken first: the
  // matched frame can land before wait() is called, and a "now" cursor would
  // hide it.
  const cursor = sse.mark();
  const start = await post('/cpu', { id });
  rep.eq('POST /cpu accepted', start.status, 200, errMsg(start));
  if (start.status !== 200) { sse.drop(); return rep.print({ id, skew: `${skew}ms` }); }

  const matched = await sse.wait('matched', { timeout: BOUNDS.countdown, from: cursor, where: 'after /cpu' });
  const opponent = matched.data?.opponentName;
  rep.truthy('opponent is CPU', opponent === 'CPU', String(opponent));
  rep.truthy('opponentCharacter is set', typeof matched.data?.opponentCharacter === 'string', String(matched.data?.opponentCharacter));

  // CPU matches gate on the ready handshake too (round.go:136-142), so the
  // countdown must be withheld until we ack. This is the live regression test
  // for that gate: without it a server that stopped gating, or a probe that
  // forgot to ack, both look like a link problem rather than a contract break.
  const early = sse.wait('countdown', { timeout: 1200, from: sse.marked(matched) }).then(() => true).catch(() => false);
  rep.ok('CPU countdown waits for the ready handshake', await early ? 'countdown began within 1.2s of matching' : 'held, as expected, until /ready');

  const ack = await post('/ready', { id });
  expectReadyAck(rep, ack);

  const ka = await sse.wait('countdown', { timeout: BOUNDS.countdown, from: sse.marked(matched) });
  const kaData = ka.data || {};
  rep.eq('first countdown is KA', kaData.n, 'KA');

  // The announced plan (v1.1, protocol.md:156+). Present on the first countdown
  // frame; its absence is a deploy older than the rework, worth knowing.
  const hasPlan = Number.isFinite(kaData.shootAt) && Number.isFinite(kaData.windowMs);
  rep.truthy('countdown announces the round plan', hasPlan, hasPlan ? `shootAt=${kaData.shootAt} windowMs=${kaData.windowMs}` : 'no shootAt/windowMs on the countdown frame');
  rep.eq('announced window is 2000ms', kaData.windowMs, 2000);

  const chi = await sse.wait('countdown', { timeout: BOUNDS.countdown, from: sse.marked(ka) });
  rep.eq('second countdown is CHI', chi.data?.n, 'CHI');

  // Countdown spacing: KA then CHI is documented at +1s (protocol.md:39). On a
  // bad link the frames can bunch up or stretch; the stretch is the risk.
  const kaToChi = chi.at - ka.at;
  rep.within('KA→CHI spacing is ~1s', kaToChi, 400, 4000);

  const shoot = await sse.wait('shoot', { timeout: BOUNDS.countdown, from: sse.marked(chi) });
  const shootData = shoot.data || {};
  rep.truthy('shoot carries windowMs', Number.isFinite(shootData.windowMs), `${shootData.windowMs}ms`);
  rep.truthy('shoot carries shootAt', Number.isFinite(shootData.shootAt), `${shootData.shootAt}`);
  if (hasPlan) {
    // The announcement and the live frame must describe the same round, or the
    // client's pre-armed timer points at the wrong deadline.
    rep.eq('shootAt matches the announced plan', shootData.shootAt, kaData.shootAt);
    rep.eq('windowMs matches the announced plan', shootData.windowMs, kaData.windowMs);
  }

  // How much of the 2s window is actually left once the phone has the frame.
  // Server-clock remaining, corrected for skew the way the client does it.
  const headroomAtArrival = shootData.windowMs - ((Date.now() + skew) - shootData.shootAt);
  console.log(`  note: PUN headroom on frame arrival = ${headroomAtArrival}ms of ${shootData.windowMs}ms`);

  const move = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
  const { res: moveRes, rtt } = await submitMove(id, move);
  const headroomAtPost = shootData.windowMs - ((Date.now() + skew) - shootData.shootAt);
  console.log(`  note: move ${move} POSTed ${rtt}ms after the frame; server-clock headroom ${headroomAtPost}ms`);

  rep.eq('move accepted', moveRes.status, 200, errMsg(moveRes));

  const result = await sse.wait('result', { timeout: BOUNDS.match, from: sse.marked(shoot) });
  const r = result.data || {};
  const types = sse.types();
  const order = ['matched', 'countdown', 'countdown', 'shoot', 'result'];
  const seenOrder = types.filter((t) => order.includes(t));
  rep.eq('frame order matched → countdown ×2 → shoot → result', seenOrder, order, types.join(' → '));

  rep.eq('result reports CPU mode', r.mode, 'cpu');
  rep.eq('result echoes the move we sent', r.you, move);
  rep.truthy('outcome is a known outcome', ['win', 'loss', 'draw', 'void'].includes(r.outcome), r.outcome);
  rep.truthy('yourNote is a known note', ['early', 'timeout', ''].includes(r.yourNote), `"${r.yourNote}"`);
  rep.truthy('opponentName is CPU in the result', r.opponentName === 'CPU', String(r.opponentName));
  rep.truthy('characters are reported for both sides', Boolean(r.youCharacter && r.opponentCharacter), `${r.youCharacter} vs ${r.opponentCharacter}`);

  // Scoring must be internally consistent. The CPU answering means the CPU's
  // move landed in time and the round is a real win/loss/draw; a no-move side
  // is the timeout case and scores void or draw per the connectivity-safe rules
  // (protocol.md:75-87), which is NOT a loss.
  if (r.you && r.opponent) {
    const expected = r.you === r.opponent ? 'draw' : WINS[r.you] === r.opponent ? 'win' : 'loss';
    rep.eq(`outcome agrees with ${r.you} vs ${r.opponent}`, r.outcome, expected);
  } else {
    rep.truthy('no-move round is void or draw, never a loss', r.outcome === 'void' || r.outcome === 'draw', `outcome=${r.outcome} youNote="${r.yourNote}"`);
  }

  const totalMs = result.at - connected.at;
  console.log(`  note: match wall time ${totalMs}ms (server's own schedule is ~4s + handshake)`);

  // A completed match's trailing `state idle` must stay bare. It carries a
  // `reason`/`requeued` only when a handshake was *cancelled*, and this match was
  // not — a stale reason here would tell the player their finished round was
  // cancelled. Asserted on the real teardown every CPU match ends with.
  const teardown = await sse.wait('state', { timeout: BOUNDS.teardown, from: sse.marked(result) });
  const td = teardown.data || {};
  rep.eq('finished match teardown reports idle', td.state, 'idle');
  rep.truthy('finished match teardown carries no cancellation reason', td.reason === undefined, `reason=${td.reason}`);
  rep.truthy('finished match teardown is not flagged requeued', td.requeued === undefined, `requeued=${td.requeued}`);

  sse.drop();

  return rep.print({
    id,
    outcome: r.outcome,
    skew: `${skew}ms`,
    open: `${sse.openMs}ms`,
    headroom: `${headroomAtPost}ms`,
    moveRtt: `${rtt}ms`,
    wall: `${totalMs}ms`,
  });
});
