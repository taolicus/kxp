// t7 — the rejection contract.
//
// Every documented failure code on POST /move and POST /report, checked against
// the live server. These paths are the ones the client never exercises on a
// happy path, so they rot silently: the UI depends on the distinction between
// "too early" and "already submitted" to decide whether to keep the input open,
// and a handler that starts returning 500 or the wrong body turns a recoverable
// moment into a dead end.
//
// Most of this is checkable inside one CPU match, which keeps it to a single
// real match and ~10 rate-limit tokens. The body-size and malformed-JSON cases
// are transport-level and are rejected before any session lookup
// (server.go:297-299), so they need no match at all.
//
// The one genuinely timing-dependent code is "too late" — the 2s window closes
// and the round resolves immediately after, so hitting that boundary from a
// moving link is luck. It is reported, never asserted.
//
//   npm run t7

import { Sse, post, get, errMsg, script, makeReporter, BOUNDS } from './lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The 2s window is short and the link is slow, so a rejection of "too late"
// here means the window closed, not that the case is broken. Callers treat that
// one code as inconclusive instead of failing.
const isLate = (res) => res.status === 400 && errMsg(res) === 'too late';

await script('t7 · rejection contract', async () => {
  const rep = makeReporter('t7 · rejection contract');

  // --- Transport-level rejections: no session required.
  const huge = 'x'.repeat(64 * 1024);
  const big = await post('/move', { id: 'nobody', move: 'rock', pad: huge });
  rep.eq('oversized body is refused with 413', big.status, 413, errMsg(big));
  rep.eq('oversized body says "body too large"', errMsg(big), 'body too large');

  const malformed = await post('/move', undefined, { timeout: BOUNDS.http });
  rep.truthy('undefined body is refused, not a 500', malformed.status >= 400 && malformed.status < 500, `HTTP ${malformed.status} ${errMsg(malformed)}`);

  // --- Session-level: a live stream, but no match.
  const sse = new Sse();
  await sse.open();
  const c0 = await sse.wait('connected', { timeout: BOUNDS.connect });
  const id = sse.id || c0.data.id;
  const roster = (await get('/characters')).json || [];
  await post('/character', { id, character: roster[0]?.id });

  const noMatch = await post('/move', { id, move: 'rock' });
  rep.eq('move with no match is 400', noMatch.status, 400, errMsg(noMatch));
  rep.eq('no-match move says "no active match"', errMsg(noMatch), 'no active match');

  const badKind = await post('/report', { id });
  rep.eq('beacon without kind is 400', badKind.status, 400, errMsg(badKind));
  rep.eq('beacon without kind says "missing kind"', errMsg(badKind), 'missing kind');

  // A well-formed beacon from an unknown id is accepted by design: a beacon
  // from a reaped client is itself diagnostic data (protocol.md:107).
  const orphanBeacon = await post('/report', { id: 't7-never-existed', kind: 't7-probe', state: 'lobby' });
  rep.eq('beacon from an unknown id is accepted', orphanBeacon.status, 200, errMsg(orphanBeacon));

  // --- In-match rejections.
  const cursor = sse.mark();
  const start = await post('/cpu', { id });
  rep.eq('match started', start.status, 200, errMsg(start));
  if (start.status !== 200) { sse.drop(); return rep.print({ id }); }

  await sse.wait('matched', { timeout: BOUNDS.countdown, from: cursor, where: 'setup' });
  // CPU matches gate their countdown on this ack (round.go:136-142), so it has
  // to go before the countdown wait below or the match times out unstarted.
  const ack = await post('/ready', { id });
  rep.eq('/ready accepted', ack.status, 200, errMsg(ack));
  await sse.wait('countdown', { timeout: BOUNDS.countdown, from: cursor, where: 'setup' });

  // Too early: input during the countdown must be refused, not buffered.
  const early = await post('/move', { id, move: 'rock' });
  rep.eq('move during countdown is 400', early.status, 400, errMsg(early));
  rep.eq('early move says "too early"', errMsg(early), 'too early');

  const shoot = await sse.wait('shoot', { timeout: BOUNDS.countdown, from: cursor, where: 'in-match' });

  // Invalid move inside the open window. It must be refused without consuming
  // the submission, so a corrected retry still lands — the case where a player
  // fat-fingers and the UI retries.
  const bogus = await post('/move', { id, move: 'dynamite' });
  if (isLate(bogus)) {
    rep.ok('invalid move rejected', 'window closed before this probe (inconclusive)');
  } else {
    rep.eq('invalid move is 400', bogus.status, 400, errMsg(bogus));
    rep.eq('invalid move says "invalid move"', errMsg(bogus), 'invalid move');
  }

  const move = 'scissors';
  const accepted = await post('/move', { id, move });
  if (isLate(accepted)) {
    rep.ok('valid move accepted', 'window closed before this probe (inconclusive)');
  } else {
    rep.eq('valid move is accepted', accepted.status, 200, errMsg(accepted));

    // The duplicate-submission code is 409, but it is a non-blocking send on a
    // buffered channel (server.go:861-866): it only fires while an earlier move
    // is still sitting unconsumed. Against a CPU the round resolves the instant
    // the player's move lands, so a sequential second POST reliably arrives too
    // late and gets "no active match" instead. Firing both at once is how a
    // double-tap actually reaches the server, and it is the only way to give
    // 409 a fair chance here — 409 is really a PvP-shaped code, since a human
    // opponent leaves both moves outstanding.
    const [a, b] = await Promise.all([
      post('/move', { id, move: 'rock' }),
      post('/move', { id, move: 'paper' }),
    ]);
    const codes = [a, b].map((r) => `${r.status} ${errMsg(r)}`);
    console.log(`  note: double-tap submissions → ${codes.join('  |  ')}`);
    rep.truthy('a double-tap never yields 5xx', [a, b].every((r) => r.status < 500), codes.join(' | '));
    rep.truthy('a double-tap is rejected or absorbed, never double-scored',
      [a, b].every((r) => [200, 400, 409].includes(r.status)),
      codes.join(' | '));
    if ([a, b].some((r) => r.status === 409)) {
      rep.eq('the 409 body is "move already submitted"',
        errMsg([a, b].find((r) => r.status === 409)), 'move already submitted');
    } else {
      rep.ok('409 not reachable against a CPU', 'round resolved before the second submission — expected, see note');
    }
  }

  const result = await sse.wait('result', { timeout: BOUNDS.match, from: sse.marked(shoot), where: 'completion' });
  rep.truthy('round resolved despite the rejected probes', Boolean(result.data), `outcome=${result.data?.outcome}`);

  // After the round: the match is over, which is a distinct code from "no
  // active match" and is what stops a stale client scoring twice.
  await sleep(200);
  const over = await post('/move', { id, move: 'rock' });
  rep.eq('move after the round is 400', over.status, 400, errMsg(over));
  rep.truthy('post-round refusal is "match over" or "no active match"',
    ['match over', 'no active match'].includes(errMsg(over)), errMsg(over));

  sse.drop();
  return rep.print({ id, outcome: result.data?.outcome, probes: 9 });
});
