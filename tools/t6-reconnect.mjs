// t6 — mid-match reconnect and reconciliation.
//
// The most important script in the suite. On a moving train the stream WILL
// drop mid-round, and the whole design rests on what happens next: the client
// reconnects and re-reads the `connected` snapshot to learn where it is
// (web/app.js:416-439), and a stall watchdog force-closes the stream after 6s
// of silence to force exactly that (web/app.js:23-32).
//
// What the server actually does, from the source: the /events handler defers
// endConn (server.go:327), which deletes the client and clears c.match
// (server.go:451-473) the moment the old connection tears down. There is NO
// grace period. The only thing that keeps a match alive across a drop is the
// connID staleness check in endConn: a reconnect that lands before the old
// handler's defer runs supersedes it and the match survives.
//
// So a drop has two legitimate outcomes and this script asserts the contract
// that holds for BOTH, which is the property that matters: a client is never
// stuck, and can always get back to a playable state.
//
//   fast drop  — reconnect immediately, racing the teardown. Match may well
//                survive; if it does, the round must still be winnable.
//   slow drop  — reconnect after the server has certainly noticed. The match
//                is gone by design, and the client must land in a healthy
//                lobby able to start a fresh match.
//
// The failure this exists to catch is the original protocol's defect
// (docs/features/protocol.md:146): "skip PUN → Waiting for result → You lose", a client
// with no way to act and no way out. So the load-bearing assertion is that
// after any drop the client reaches a resolved, playable state.
//
// Consumes two real matches and ~16 rate-limit tokens.
//
//   npm run t6
//   RECONNECT_GAP=800 npm run t6      # tune the slow-drop gap

import { Sse, post, get, errMsg, script, makeReporter, BOUNDS, expectReadyAck } from './lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh EventSource on the same id, exactly as the browser does. This is a
// genuinely new TCP connection, so it exercises a cold path over a link that
// may still be recovering.
async function reconnect(id, timeout = BOUNDS.reconnect) {
  const sse = new Sse(id);
  const started = Date.now();
  await sse.open({ timeout });
  const connected = await sse.wait('connected', { timeout, where: 'after reconnect' });
  return { sse, data: connected.data || {}, ms: Date.now() - started };
}

// Start a match, drop the stream mid-countdown, wait out `gapMs`, reconnect,
// then insist the session is playable again. Returns the facts the reporter
// needs; asserts only what is contractual for either outcome.
async function dropScenario(rep, label, gapMs) {
  const sse0 = new Sse();
  await sse0.open();
  const c0 = await sse0.wait('connected', { timeout: BOUNDS.connect });
  const id = sse0.id || c0.data.id;
  const roster = (await get('/characters')).json || [];
  await post('/character', { id, character: roster[Math.floor(Math.random() * roster.length)]?.id });

  const cursor = sse0.mark();
  const start = await post('/cpu', { id });
  if (start.status !== 200) {
    rep.fail(`${label}: match started`, `HTTP ${start.status} ${errMsg(start)}`);
    sse0.drop();
    return null;
  }
  await sse0.wait('matched', { timeout: BOUNDS.countdown, from: cursor, where: `${label} setup` });
  // CPU matches gate their countdown on this ack (round.go:136-142). Without it
  // the match sits in the handshake until readyTimeout and never counts down.
  await post('/ready', { id });
  await sse0.wait('countdown', { timeout: BOUNDS.countdown, from: cursor, where: `${label} setup` });

  const droppedAt = Date.now();
  sse0.drop();
  await sleep(gapMs);

  const second = await reconnect(id);
  const d = second.data;
  const alive = d.state === 'ingame';
  console.log(`  note: ${label} — reconnect in ${second.ms}ms after a ${gapMs}ms gap → state=${d.state} phase=${d.phase}`);

  rep.truthy(`${label}: reconnect yields a well-formed snapshot`, Boolean(d.id), `id=${d.id}`);
  rep.eq(`${label}: snapshot is the same session`, d.id, id);
  rep.truthy(`${label}: state is a known state`, ['idle', 'waiting', 'ingame'].includes(d.state), d.state);

  if (alive) {
    // The match outlived the drop. It must still be playable to the end — the
    // whole point of the snapshot carrying phase/shootAt/windowMs.
    rep.truthy(`${label}: live snapshot names a phase`, ['countdown', 'shoot', 'done'].includes(d.phase), String(d.phase));
    rep.truthy(`${label}: live snapshot carries opponent info`, Boolean(d.opponentName), String(d.opponentName));
    if (d.phase === 'shoot') {
      rep.truthy(`${label}: shoot snapshot carries shootAt`, Number.isFinite(d.shootAt), String(d.shootAt));
      rep.truthy(`${label}: shoot snapshot carries windowMs`, Number.isFinite(d.windowMs), String(d.windowMs));
      const left = d.windowMs - ((Date.now() + (d.now ? d.now - Date.now() : 0)) - d.shootAt);
      console.log(`  note: ${label} — rejoined with ~${Math.round(left)}ms of the PUN window left`);
    }
    if (d.phase !== 'done') {
      const shoot = await second.sse.wait('shoot', { timeout: BOUNDS.countdown, from: second.sse.mark(), where: `${label} completion` });
      const mv = await post('/move', { id, move: 'rock', sawPunAt: Date.now(), clickedAt: Date.now() });
      rep.eq(`${label}: move after reconnect accepted`, mv.status, 200, errMsg(mv));
      const result = await second.sse.wait('result', { timeout: BOUNDS.match, from: second.sse.marked(shoot), where: `${label} completion` });
      rep.truthy(`${label}: round still resolves after the drop`, Boolean(result.data), `outcome=${result.data?.outcome}`);
      console.log(`  note: ${label} — resolved ${result.at - droppedAt}ms after the drop`);
    }
  } else {
    // Match cancelled by design. The client must be in the lobby and able to
    // play again: a cancelled round that leaves no way back is the bug.
    rep.truthy(`${label}: a cancelled match lands in the lobby`, d.state === 'idle', `state=${d.state}`);
    const cursor2 = second.sse.mark();
    const again = await post('/cpu', { id });
    rep.eq(`${label}: a fresh match can be started after the drop`, again.status, 200, errMsg(again));
    if (again.status === 200) {
      // Same gate as above, on the recovery match: wait for `matched`, then ack.
      await second.sse.wait('matched', { timeout: BOUNDS.countdown, from: cursor2, where: `${label} recovery setup` });
      const ack = await post('/ready', { id });
      expectReadyAck(rep, ack, `${label}: /ready accepted on the recovered match`);
      const shoot = await second.sse.wait('shoot', { timeout: BOUNDS.countdown, from: cursor2, where: `${label} recovery` });
      const mv = await post('/move', { id, move: 'paper', sawPunAt: Date.now(), clickedAt: Date.now() });
      rep.eq(`${label}: recovered match accepts a move`, mv.status, 200, errMsg(mv));
      const result = await second.sse.wait('result', { timeout: BOUNDS.match, from: second.sse.marked(shoot), where: `${label} recovery` });
      rep.truthy(`${label}: recovered match reaches a result`, Boolean(result.data), `outcome=${result.data?.outcome}`);
    }
  }

  second.sse.drop();
  return { id, alive, reconnectMs: second.ms, gapMs };
}

await script('t6 · mid-match reconnect and reconciliation', async () => {
  const rep = makeReporter('t6 · mid-match reconnect and reconciliation');
  const slowGap = Number(process.env.RECONNECT_GAP || 3000);

  const fast = await dropScenario(rep, 'fast drop', 120);
  const slow = await dropScenario(rep, 'slow drop', slowGap);

  // Reconnecting after everything is over must not invent a live round, and a
  // move must be refused — otherwise a stale client could keep scoring.
  if (slow) {
    const after = await reconnect(slow.id);
    rep.eq('post-match reconnect is the same session', after.data.id, slow.id);
    rep.truthy('post-match snapshot is idle or finished',
      after.data.state === 'idle' || after.data.phase === 'done',
      `state=${after.data.state} phase=${after.data.phase}`);
    const late = await post('/move', { id: slow.id, move: 'rock' });
    rep.truthy('move after the match is refused', late.status !== 200, `HTTP ${late.status} ${errMsg(late)}`);
    rep.eq('refusal is "no active match"', errMsg(late), 'no active match');
    after.sse.drop();
  }

  return rep.print({
    fast: fast ? `${fast.reconnectMs}ms, match ${fast.alive ? 'survived' : 'cancelled'}` : 'n/a',
    slow: slow ? `${slow.reconnectMs}ms, match ${slow.alive ? 'survived' : 'cancelled'}` : 'n/a',
    slowGap: `${slowGap}ms`,
  });
});
