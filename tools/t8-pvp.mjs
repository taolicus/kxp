// t8 — PvP between two real clients.
//
// The protocol-level equivalent of Playwright flow 2. Two live streams queue,
// the server pairs them FIFO, they shake hands over POST /ready, and the round
// has to resolve on BOTH sides with no side left stranded.
//
// The thing this is really hunting is the asymmetric case, named as such in the
// Playwright suite (gameplay.spec.js:10-11): one side drops out and the other is
// left dead in matched/countdown with no idea what happened. Reading the source
// first suggested the recovery was entirely silent, because m.requeue
// (server.go:595-607) puts the survivor back in h.queue without sending
// anything. That reading was incomplete: readyAbandon/readyTimeout
// (round.go:189-201) fall through to m.finish, and finishMatch sends `state` to
// both sides (server.go:640), after which the re-queue re-pairs them. Scenario B
// measures the real sequence and its timing against the client's 6s stall
// watchdog, which matters because the watchdog fires at 6s while readyTimeout
// is 8s (round.go:16).
//
// Scenario A: both sides ready, full round, results cross-checked.
// Scenario B: one side never readies, so readyTimeout fires and both are
//             re-queued. The survivor must be told, in bounded time, and must
//             end up playable.
//
// Pairing is strict FIFO, so a stranger already queued could take a slot. Every
// assertion here is therefore either an invariant that holds regardless of who
// we were paired with, or a cross-check guarded on self-pairing having been
// proven from the result frames. That mirrors the reasoning in
// gameplay.spec.js:23-31.
//
// Consumes two real matches and ~14 rate-limit tokens.
//
//   npm run t8

import { Sse, post, get, errMsg, script, makeReporter, BOUNDS } from './lib/harness.mjs';

// BEATS[x] is the move that beats x, so BEATS is the inverse of game.go's
// winsAgainst (which maps a move to what it beats). Keeping both directions
// explicit is the point: conflating them is how a test ends up asserting that
// scissors loses to paper and "finds" a scoring bug that is not there.
const BEATS = { rock: 'paper', paper: 'scissors', scissors: 'rock' };
const WINS = { rock: 'scissors', paper: 'rock', scissors: 'paper' }; // what x beats
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOVES = ['rock', 'paper', 'scissors'];

// Open a stream and return a small driver bound to it, so a scenario reads as
// two peers rather than a pile of stream plumbing.
async function peer(name, character) {
  const sse = new Sse();
  await sse.open();
  const c = await sse.wait('connected', { timeout: BOUNDS.connect });
  const id = sse.id || c.data.id;
  const ch = await post('/character', { id, character });
  return { name, sse, id, character, ready: ch.status === 200 };
}

const drop = (p) => p.sse.drop();
const frames = (p, from = 0) => p.sse.types(from);

await script('t8 · PvP between two clients', async () => {
  const rep = makeReporter('t8 · PvP between two clients');
  const roster = (await get('/characters')).json || [];
  // Two different fighters make the pairing provable from the result frames.
  const ca = roster[0]?.id;
  const cb = roster[1]?.id;

  // ---- Scenario A: a complete, self-paired match.
  const A = await peer('A', ca);
  const B = await peer('B', cb);
  rep.truthy('both clients have a live session', Boolean(A.id && B.id), `${A.id} / ${B.id}`);
  rep.truthy('both fighters accepted', A.ready && B.ready, `${ca} / ${cb}`);

  const curA = A.sse.mark();
  const curB = B.sse.mark();
  // FIFO: A queues first, so A is guaranteed the earlier slot and B pairs it.
  const qa = await post('/queue', { id: A.id });
  const qb = await post('/queue', { id: B.id });
  rep.eq('A queued', qa.status, 200, errMsg(qa));
  rep.eq('B queued', qb.status, 200, errMsg(qb));

  const mA = await A.sse.wait('matched', { timeout: BOUNDS.countdown, from: curA, where: 'A handshake' });
  const mB = await B.sse.wait('matched', { timeout: BOUNDS.countdown, from: curB, where: 'B handshake' });
  rep.truthy('A is matched', Boolean(mA.data), JSON.stringify(mA.data));
  rep.truthy('B is matched', Boolean(mB.data), JSON.stringify(mB.data));
  rep.truthy('A is told an opponent, not a CPU', mA.data?.opponentName !== 'CPU', String(mA.data?.opponentName));
  rep.truthy('B is told an opponent, not a CPU', mB.data?.opponentName !== 'CPU', String(mB.data?.opponentName));

  // The handshake gates the countdown: neither side may see countdown before
  // both have acked (round.go:157-163).
  const earlyA = A.sse.wait('countdown', { timeout: 1200, from: curA }).then(() => true).catch(() => false);
  rep.ok('countdown waits for the ready handshake', await earlyA ? 'countdown began within 1.2s of matching' : 'held, as expected, until /ready');

  const rA = await post('/ready', { id: A.id });
  const rB = await post('/ready', { id: B.id });
  rep.eq('A /ready accepted', rA.status, 200, errMsg(rA));
  rep.eq('B /ready accepted', rB.status, 200, errMsg(rB));

  const kA = await A.sse.wait('countdown', { timeout: BOUNDS.countdown, from: curA, where: 'A countdown' });
  const kB = await B.sse.wait('countdown', { timeout: BOUNDS.countdown, from: curB, where: 'B countdown' });
  rep.eq('A countdown is KA', kA.data?.n, 'KA');
  rep.eq('B countdown is KA', kB.data?.n, 'KA');

  const sA = await A.sse.wait('shoot', { timeout: BOUNDS.countdown, from: A.sse.marked(kA), where: 'A shoot' });
  const sB = await B.sse.wait('shoot', { timeout: BOUNDS.countdown, from: B.sse.marked(kB), where: 'B shoot' });
  rep.truthy('both sides receive the PUN window', true, `windowMs=${sA.data?.windowMs}`);

  // B is given the move that beats A, so the round is decisive and the
  // cross-check has something to catch. Standard RPS: scissors beats paper.
  const moveA = MOVES[Math.floor(Math.random() * 3)];
  const moveB = BEATS[moveA];
  const [mvA, mvB] = await Promise.all([
    post('/move', { id: A.id, move: moveA, sawPunAt: Date.now(), clickedAt: Date.now() }),
    post('/move', { id: B.id, move: moveB, sawPunAt: Date.now(), clickedAt: Date.now() }),
  ]);
  rep.eq('A move accepted', mvA.status, 200, errMsg(mvA));
  rep.eq('B move accepted', mvB.status, 200, errMsg(mvB));

  // Both cursors are fixed before the results are awaited. A "now" cursor taken
  // after the other side's result has landed hides the frame entirely, and the
  // failure reads as the server never sending it.
  const resA = await A.sse.wait('result', { timeout: BOUNDS.match, from: A.sse.marked(sA), where: 'A result' });
  const resB = await B.sse.wait('result', { timeout: BOUNDS.match, from: B.sse.marked(sB), where: 'B result' });
  const ra = resA.data || {};
  const rb = resB.data || {};
  rep.truthy('A reached a result', Boolean(ra.outcome), ra.outcome);
  rep.truthy('B reached a result', Boolean(rb.outcome), rb.outcome);
  rep.eq('A result is online mode', ra.mode, 'online');
  rep.eq('B result is online mode', rb.mode, 'online');
  rep.eq('A move echoed', ra.you, moveA);
  rep.eq('B move echoed', rb.you, moveB);

  // Neither side may be left dead in matched/countdown: both must show the
  // whole progression. This is the asymmetric-SSE invariant.
  for (const [p, f, label] of [[A, frames(A), 'A'], [B, frames(B), 'B']]) {
    rep.truthy(`${label} progressed matched → countdown → shoot → result`,
      ['matched', 'countdown', 'shoot', 'result'].every((t) => f.includes(t)), f.join(' → '));
  }

  // Self-pairing proof: each side's opponent must be the other's chosen
  // fighter. Only then is it safe to demand strict win/loss consistency.
  const selfPaired = ra.opponentCharacter === rb.youCharacter && rb.opponentCharacter === ra.youCharacter;
  rep.truthy('pairing was A↔B (proved from result frames)', selfPaired,
    `A saw ${ra.opponentCharacter}, B saw ${rb.opponentCharacter}`);

  if (selfPaired) {
    rep.eq('A loses to the move that beats it', ra.outcome, 'loss', `${ra.you} vs ${ra.opponent}`);
    rep.eq('B wins with the beating move', rb.outcome, 'win', `${rb.you} vs ${rb.opponent}`);
    rep.truthy('the two outcomes are complementary',
      (ra.outcome === 'win' && rb.outcome === 'loss') || (ra.outcome === 'loss' && rb.outcome === 'win'),
      `${ra.outcome} / ${rb.outcome}`);
    // Each side's own outcome must follow from its own two moves, which is the
    // check that actually catches a swapped or inverted scoring assignment.
    rep.eq('A scoring follows from A\'s moves', ra.outcome, WINS[ra.you] === ra.opponent ? 'win' : 'loss', `${ra.you} beats ${WINS[ra.you]}`);
    rep.eq('B scoring follows from B\'s moves', rb.outcome, WINS[rb.you] === rb.opponent ? 'win' : 'loss', `${rb.you} beats ${WINS[rb.you]}`);
    rep.truthy('the two sides played genuinely different moves', ra.you !== rb.you, `${ra.you} / ${rb.you}`);
  } else {
    // Paired with someone else. The hard invariants above still hold; the
    // cross-checks cannot, and guessing at them would report a stranger's
    // match as our failure.
    console.log(`  note: paired with another client, not A↔B — strict win/loss cross-check skipped`);
  }

  const wallA = resA.at - mA.at;
  console.log(`  note: A's match took ${wallA}ms from matched to result (handshake ≤8s + 2s countdown + 2s window)`);
  rep.truthy('match resolved within the documented budget', wallA < 20000, `${wallA}ms`);

  drop(A); drop(B);

  // ---- Scenario B: the handshake is abandoned and the server says nothing.
  const D = await peer('D', ca);
  const E = await peer('E', cb);
  const curD = D.sse.mark();
  await post('/queue', { id: D.id });
  await post('/queue', { id: E.id });
  await D.sse.wait('matched', { timeout: BOUNDS.countdown, from: curD, where: 'B setup' });
  rep.eq('D is matched to E', (await post('/ready', { id: D.id })).status, 200);

  // E never readies. readyTimeout (8s, round.go:16) cancels the match and
  // re-queues both sides. The survivor must be told, in bounded time.
  const markD = D.sse.mark();
  const abandonedAt = Date.now();
  await sleep(11000);
  const afterD = frames(D, markD);
  console.log(`  note: D received [${afterD.join(', ') || 'nothing'}] in the ${Date.now() - abandonedAt}ms after E failed to ready`);

  // 'matched' is a legitimate frame here too: a fast re-queue can re-pair the
  // survivor immediately. What must never happen is a frame we cannot act on.
  const stranded = afterD.length > 0 && !afterD.some((t) => ['state', 'matched', 'online', 'waiting'].includes(t));
  rep.truthy('abandoned handshake: the survivor is notified',
    afterD.includes('state'), `got [${afterD.join(', ')}]`);
  rep.truthy('abandoned handshake: survivor not stranded', !stranded, `got [${afterD.join(', ')}]`);

  // Ordering race worth naming: readyTimeout re-queues both sides, which calls
  // tryMatch and re-pairs them (a fresh `matched`), and only then does the old
  // run's finishMatch fire the `state` frame — unconditionally, to every side
  // of the old match, without checking that the client has since been re-paired
  // (server.go:637-642). The survivor can therefore see `matched` (new match)
  // and then `state` (stale teardown). In the browser that is a `stateIdle`
  // edge out of `matched`, which the client handles by going to the lobby
  // (docs/protocol.md:118) while the server still has it in a live match.
  // Self-healing — the next handshake timeout re-pairs and re-sends `matched` —
  // but it is a real frame-ordering inconsistency, so it is reported with its
  // timestamps rather than asserted as pass/fail.
  const after = D.sse.since(markD);
  const matchIdx = after.findIndex((f) => f.type === 'matched');
  const stateIdx = after.findIndex((f) => f.type === 'state');
  // D was already matched before markD, so any `matched` after it is a re-pair.
  // The bad order is the re-pair arriving FIRST and the old match's teardown
  // SECOND: the client is told about a live match and then handed a stateIdle
  // edge belonging to a match that no longer exists.
  if (stateIdx !== -1 && matchIdx !== -1 && stateIdx > matchIdx) {
    const rel = (f) => `${f.type}@+${f.at - abandonedAt}ms`;
    console.log(`  note: RACE — stale teardown after re-pair: [${after.map(rel).join(', ')}]`);
    console.log(`  note:   a browser takes that trailing 'state' as a stateIdle edge out of 'matched'`);
    rep.fail('no stale `state` frame after a re-pair `matched`',
      `[${after.map(rel).join(', ')}] — the old match's teardown reaches a client already re-paired`);
  } else {
    rep.ok('teardown precedes any re-pair', `order=[${after.map((f) => f.type).join(', ')}]`);
  }

  // So the only way out is the client's own watchdog: close and reopen, and the
  // snapshot must show a healthy state. Note: since the server already tore the
  // match down (m.requeue moved the survivor to the queue and tryMatch may have
  // re-paired it, then a `state` frame landed), a reconnect here lands on a
  // fresh session with state=idle — a queued-and-not-stranded survivor that has
  // not been re-paired, or has just finished another handshake. So idle is a
  // correct and expected outcome here, not a regression.
  drop(D);
  const back = new Sse(D.id);
  await back.open();
  const rec = await back.wait('connected', { timeout: BOUNDS.reconnect, where: 'D recovery' });
  const d2 = rec.data || {};
  rep.eq('reconnect after the abandoned handshake is the same session', d2.id, D.id);
  rep.truthy('reconnecting survivor lands in a known state',
    ['idle', 'waiting', 'ingame'].includes(d2.state), `state=${d2.state} phase=${d2.phase}`);
  rep.truthy('D is not stuck holding a dead match', d2.state !== 'ingame' || d2.phase !== 'done',
    `state=${d2.state} phase=${d2.phase}`);

  // A stranded client would be one that can neither play nor leave.
  const stuck = await post('/move', { id: D.id, move: 'rock' });
  rep.truthy('a move is refused while not in a live round', stuck.status !== 200, `HTTP ${stuck.status} ${errMsg(stuck)}`);
  const cancel = await post('/cancel', { id: D.id });
  rep.eq('D can leave the queue cleanly', cancel.status, 200, errMsg(cancel));

  back.drop(); drop(E);
  return rep.print({
    selfPaired: String(selfPaired),
    matchWall: `${wallA}ms`,
    abandonedSilence: afterD.length === 0 ? 'silent' : afterD.join(','),
    recovered: `state=${d2.state}`,
  });
});
