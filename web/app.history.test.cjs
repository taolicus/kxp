// Drives the real web/app.js match history: what a match writes, what is read
// back out of storage, and what the lobby's record draws for it.
//
// Expansion itself -- does a <details> open, how a long summary wraps -- is not
// checked here, and cannot be on this host: the harness stubs the DOM and
// nothing here has a browser (docs/development/verification.md). What is
// asserted is the markup the client puts in the view and the storage behind it,
// which is where every decision this feature makes actually lives.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp, stubElement } = require('./appHarness.cjs');
const KXP = require('./kxp.js');
const SM = require('./machine.js');

const ROSTER = [
  { id: 'dragon', name: 'Dragon', emoji: 'd' },
  { id: 'hielito', name: 'Hielito', emoji: 'h' },
  { id: 'rayito', name: 'Rayito', emoji: 'r' },
];

// The harness clock. Frames are stamped a few ms past it, so "the frame's own
// timestamp" and "the moment it arrived" are different numbers and a test can
// tell which one the record took.
const CLOCK = 1700000000000;

// A real state machine, so an SSE frame paints rather than being parsed and
// dropped -- a record test that ran against the recording stub would pass with
// no client code having run at all.
const newApp = (opts) => loadApp({ next: SM.next, roster: ROSTER, ...opts });

// The screens show() toggles, which the harness cannot model from markup it does
// not read: the claim that the record is a screen a player is on is a claim
// about the view, not about the markup inside it.
function views(app) {
  const lobby = stubElement();
  lobby.id = 'lobby';
  const history = stubElement();
  history.id = 'history';
  const queue = stubElement();
  queue.id = 'queue';
  app.seed('.view', [lobby, history, queue]);
  return { lobby, history, queue };
}

const showing = (el) => el.classList.contains('hidden') === false;
const stored = (app) => app.saved('kxp-history');
const draws = (app) => (String(app.html('#history-list')).match(/<details/g) || []).length;

async function started(app) {
  const v = views(app);
  await app.boot();
  runInContext('connect()', app.ctx);
  app.fire('connected', { id: 'test-client', now: CLOCK, online: 0 });
  return v;
}

// The frames a first-to-three CPU series produces, in the shape the server
// sends them (round.go announce): identity on every result, the series state as
// it stands, and a timestamp from the server's clock.
const MATCHED = {
  opponentName: 'CPU', opponentCharacter: 'dragon', background: 'pool',
  roundsTarget: 3, drawEnds: false,
};

const round = ({ over, outcome = 'win', n = 1, wins = 1, losses = 0, ...rest }) => ({
  you: 'rock', opponent: 'scissors', yourNote: '', opponentNote: '',
  youClientMs: 120, opponentClientMs: 210, youTimingMs: 130, opponentTimingMs: 220,
  youCharacter: 'hielito', opponentCharacter: 'dragon', opponentName: 'CPU',
  outcome, mode: 'cpu', round: n, youRoundWins: wins, oppRoundWins: losses,
  roundsTarget: 3, drawEnds: false, seriesOver: over, ts: CLOCK + n,
  ...rest,
});

// A match already in storage, in the shape a finished match writes. The order
// is newest first, which is the order the record is kept in.
const storedEntry = (i = 0, over = {}) => ({
  outcome: 'win', mode: 'online', youCharacter: 'hielito', opponentCharacter: 'dragon',
  opponentName: 'Opponent', roundsTarget: 3, youRoundWins: 1, oppRoundWins: 0,
  background: 'pool',
  rounds: [{
    round: 1, you: 'rock', opponent: 'scissors', yourNote: '', opponentNote: '',
    youMs: 120, opponentMs: 210, outcome: 'win', note: '', ts: CLOCK + i,
  }],
  ts: CLOCK + i,
  ...over,
});

// The next round of a series, the way the client sees one: a countdown frame,
// then the result. Split out because every multi-round test below walks the
// same gap, and a copy of it in each would be testing the test.
const nextRound = (app) => app.fire('countdown', { n: 'READY', shootAt: CLOCK + 3000, windowMs: 2000 });

test('a finished match is recorded once, with the rounds it was made of', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);

  app.fire('matched', MATCHED);
  app.fire('result', round({ over: true, n: 1 }));

  const list = stored(app);
  assert.strictEqual(list.length, 1, 'one match, one entry');
  const [e] = list;
  assert.strictEqual(e.outcome, 'win');
  assert.strictEqual(e.mode, 'cpu');
  assert.strictEqual(e.youCharacter, 'hielito', 'what the frame says about the player');
  assert.strictEqual(e.opponentCharacter, 'dragon', 'and about the opponent');
  assert.strictEqual(e.roundsTarget, 3, 'and how long the match was');
  assert.strictEqual(e.background, 'pool', 'the stage it was fought on, which no result frame carries');
  assert.strictEqual(e.youRoundWins, 1);
  assert.strictEqual(e.oppRoundWins, 0);
  assert.strictEqual(e.ts, CLOCK + 1, 'the frame timestamp, not the arrival');
  assert.strictEqual(e.rounds.length, 1, 'the match is not one entry per round');
  assert.deepStrictEqual(e.rounds[0], {
    round: 1, you: 'rock', opponent: 'scissors', yourNote: '', opponentNote: '',
    youMs: 120, opponentMs: 210, outcome: 'win', note: '', ts: CLOCK + 1,
  });
});

test('a mid-series round is filed, but the match is not recorded', async () => {
  // The pin for the commit rule, and the one that bites if it is dropped: the
  // record has to hold a round that is decided without holding a match that is
  // not. Nothing is written to storage until the series is over.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);

  app.fire('matched', MATCHED);
  app.fire('result', round({ over: false, n: 1 }));
  assert.strictEqual(stored(app), null, 'round one of three is not a finished match');

  nextRound(app);
  app.fire('result', round({ over: false, n: 2, outcome: 'loss', wins: 1, losses: 1 }));
  assert.strictEqual(stored(app), null, 'nor is round two');

  nextRound(app);
  app.fire('result', round({ over: true, n: 3, wins: 2, losses: 1 }));

  const list = stored(app);
  assert.strictEqual(list.length, 1, 'the final result is what records it');
  assert.deepStrictEqual(list[0].rounds.map((r) => [r.round, r.outcome]),
    [[1, 'win'], [2, 'loss'], [3, 'win']],
    'and it holds every round the series was played over');
});

test('an abandoned series leaves nothing for the next match to inherit', async () => {
  // The other half of the commit rule: a match that never finished is not a
  // record of anything, and the rounds of one must not attach themselves to the
  // match that follows it.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);

  app.fire('matched', MATCHED);
  app.fire('result', round({ over: false, n: 1 }));
  await app.tap('#btn-mode');
  assert.strictEqual(stored(app), null, 'the player left before the series was decided');

  // The next match starts its own record: the abandoned round does not ride
  // along with it, even though the client kept it in memory.
  app.fire('matched', { ...MATCHED, background: 'tomb' });
  app.fire('result', round({ over: true, n: 1, mode: 'cpu', ts: CLOCK + 9 }));

  const list = stored(app);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].rounds.length, 1, 'only the match that was finished is in it');
  assert.strictEqual(list[0].rounds[0].ts, CLOCK + 9, 'and that round is the new match\'s');
  assert.strictEqual(list[0].background, 'tomb', 'with its own stage, not the abandoned one\'s');
});

test('a departure commits with the match it was made with', async () => {
  // What the plain form of an opponent-left frame does *not* carry: the stage,
  // the length, a series state, and -- before the wire grew them -- the
  // opponent's identity. The record reads those from the match it opened, which
  // is the whole reason the context exists.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);

  // An online match, which is the only kind a departure can come from.
  app.fire('matched', { ...MATCHED, opponentName: 'Opponent' });
  // The frame as round.go's abort sends it: nothing but an outcome, a mode and
  // a timestamp the frame does not even have.
  app.fire('opponent-left', { outcome: 'win', mode: 'online' });

  const list = stored(app);
  assert.strictEqual(list.length, 1, 'a departure decides the match, so it is recorded');
  const [e] = list;
  assert.strictEqual(e.outcome, 'win');
  assert.strictEqual(e.opponentCharacter, 'dragon', 'from the match, since the frame names no one');
  assert.strictEqual(e.opponentName, 'Opponent', 'likewise');
  assert.strictEqual(e.background, 'pool', 'and a stage no departure frame has ever carried');
  assert.strictEqual(e.ts, CLOCK, 'with the time it arrived, the frame having none');
  assert.strictEqual(e.rounds.length, 1, 'as the one round the match opened and closed on');
  assert.strictEqual(e.rounds[0].note, 'Opponent left \u2014 you win!', 'which explains itself the way the banner did');
  assert.strictEqual(e.rounds[0].ts, CLOCK, 'stamped on arrival too');
});

test('a forfeited series does not grow a round nobody won', async () => {
  // The negative direction of the rule above: a departure that decides a series
  // already in progress commits the rounds that were played and adds none of
  // its own, because a forfeit decides who takes the series rather than being a
  // round anybody won.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);

  app.fire('matched', { ...MATCHED, opponentName: 'Opponent' });
  app.fire('result', round({ over: false, n: 1 }));
  // The frame as round.go's announceForfeit sends it: series state, tally,
  // identity -- and no round, because it is not one.
  app.fire('opponent-left', {
    outcome: 'win', mode: 'online', seriesOver: true,
    youRoundWins: 1, oppRoundWins: 0, roundsTarget: 3,
    opponentName: 'Opponent', opponentCharacter: 'dragon', ts: CLOCK + 400,
  });

  const list = stored(app);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].rounds.length, 1, 'the round that was played, and no second one');
  assert.strictEqual(list[0].rounds[0].round, 1);
  assert.strictEqual(list[0].youRoundWins, 1, 'the tally the forfeit reported');
  assert.strictEqual(list[0].ts, CLOCK + 400, 'and the forfeit\'s own timestamp');
});

test('a void round is recorded as one', async () => {
  // A no-contest round: no pick on one side, so no timings to show for it and
  // an outcome that is neither a win nor a loss.
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  await started(app);

  app.fire('matched', { ...MATCHED, roundsTarget: 1, drawEnds: true });
  app.fire('result', round({
    over: true, outcome: 'void', wins: 0, losses: 1, roundsTarget: 1, drawEnds: true,
    you: '', opponent: 'rock', yourNote: 'timeout',
    youTimingMs: null, youClientMs: null, opponentTimingMs: 80, opponentClientMs: 90,
    ts: CLOCK + 7,
  }));

  const list = stored(app);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].outcome, 'void');
  const [r] = list[0].rounds;
  assert.strictEqual(r.outcome, 'void');
  assert.strictEqual(r.you, '', 'no pick on the side that timed out');
  assert.strictEqual(r.yourNote, 'timeout');
  assert.strictEqual(r.youMs, null, 'and no timing claimed for it');
  assert.strictEqual(r.opponentMs, 90, 'while the other side keeps its own');
});

test('the lobby opens the record, which draws what was recorded and when', async () => {
  const app = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito' } });
  const v = await started(app);

  await app.tap('#btn-history');
  assert.strictEqual(showing(v.history), true, 'the lobby opens the record');
  assert.strictEqual(showing(v.lobby), false, 'and steps out of its own view');
  assert.ok(app.html('#history-list').includes('No matches yet.'),
    'an empty record says so rather than drawing an empty box');

  await app.tap('#btn-history-back');
  assert.strictEqual(showing(v.lobby), true, 'the way back puts the lobby back');
  assert.strictEqual(showing(v.history), false);

  // A first-to-three match, won 2-1, played out frame by frame.
  app.fire('matched', MATCHED);
  app.fire('result', round({ over: false, n: 1 }));
  nextRound(app);
  app.fire('result', round({ over: false, n: 2, outcome: 'loss', wins: 1, losses: 1 }));
  nextRound(app);
  app.fire('result', round({ over: true, n: 3, wins: 2, losses: 1 }));
  await app.tap('#btn-mode');

  await app.tap('#btn-history');
  const html = app.html('#history-list');
  assert.strictEqual(draws(app), 1, 'one row for the match, not one per round');
  assert.ok(html.includes('Win'), 'the outcome is on the row');
  assert.ok(html.includes('CPU'), 'so is the mode');
  assert.ok(html.includes('h Hielito vs d Dragon'), 'and who fought whom');
  assert.ok(html.includes('2\u20131'), 'and how the series stood');
  assert.ok(html.includes('just now'), 'and when it was played');
  assert.ok(html.includes('Pool'), 'the stage it was fought on');
  assert.strictEqual((html.match(/R[0-9]/g) || []).length, 3, 'with the three rounds inside it');
  assert.ok(html.includes(KXP.aliases.rock), 'drawn as the moves that were played');
  assert.ok(html.includes('120/210ms'), 'and the reaction times of both sides');
});

test('an unreadable or malformed record is dropped rather than drawn', async () => {
  // Storage is writable by hand and outlives the code that wrote it, so every
  // entry is read as untrusted input: something that is not a match is skipped,
  // and what is skipped must not reach the markup. Each of these sits beside one
  // entry that reads, so a pass here is "the good one survived", not "the list
  // came out empty by accident".
  const app = newApp({
    roster: ROSTER,
    store: {
      'kxp-character': 'hielito',
      'kxp-history': ['nope', null, 42, { outcome: 'win' }, storedEntry(1),
        { ...storedEntry(2), rounds: ['nope'] }, '[]'],
    },
  });
  await started(app);
  await app.tap('#btn-history');
  const html = app.html('#history-list');
  assert.strictEqual(draws(app), 1, 'only the entry that reads is drawn');
  assert.ok(!html.includes('undefined'), 'and nothing from a field it does not have');

  const raw = newApp({ roster: ROSTER, store: { 'kxp-character': 'hielito', 'kxp-history': '{not json' } });
  await started(raw);
  await raw.tap('#btn-history');
  assert.ok(raw.html('#history-list').includes('No matches yet.'),
    'an unreadable record reads as an empty one');
});

test('the record is capped at fifty, keeping what was recorded last', async () => {
  const app = newApp({
    roster: ROSTER,
    store: {
      'kxp-character': 'hielito',
      'kxp-history': Array.from({ length: 60 }, (_, i) => storedEntry(i)),
    },
  });
  await started(app);

  app.fire('matched', MATCHED);
  app.fire('result', round({ over: true, n: 1, ts: CLOCK + 1 }));

  const list = stored(app);
  assert.strictEqual(list.length, 50, 'a write does not grow the record past its cap');
  assert.strictEqual(list[0].ts, CLOCK + 1, 'the match just played is at the front');
  assert.strictEqual(list[1].ts, CLOCK, 'followed by what was already there');
  assert.strictEqual(list[49].ts, CLOCK + 48, 'and the cap drops the tail');

  await app.tap('#btn-mode');
  await app.tap('#btn-history');
  assert.strictEqual(draws(app), 50, 'the view draws what is stored, no more');
});

test('a fighter that has left the roster still reads as the fighter that was fought', async () => {
  const app = newApp({
    roster: ROSTER,
    store: {
      'kxp-character': 'hielito',
      'kxp-history': [storedEntry(0, { opponentCharacter: 'gone-from-roster' })],
    },
  });
  await started(app);
  await app.tap('#btn-history');
  const html = app.html('#history-list');
  assert.ok(html.includes('gone-from-roster'), 'the stored id reads as itself');
  assert.ok(!html.includes('d Dragon'),
    'and never as the roster\'s first fighter, which is what characterByID falls back to');
});

test('a trailing teardown leaves the record open, and a requeue takes the player out of it', async () => {
  // The same reading `result` and `ladder` have: the teardown that follows a
  // decided match has nothing to reconcile on a screen no match is live behind.
  // The pin in both directions -- a requeued frame is the server saying the
  // queue is live, and its view has to win over the one it interrupts.
  const app = newApp({
    roster: ROSTER,
    store: { 'kxp-character': 'hielito', 'kxp-history': [storedEntry(0)] },
  });
  const v = await started(app);

  await app.tap('#btn-history');
  app.fire('state', { state: 'idle' });
  await app.settle();

  assert.strictEqual(showing(v.history), true, 'the player is still reading the record');
  assert.strictEqual(showing(v.lobby), false, 'and is not walked out of it');
  assert.ok(!app.posted().includes('/report'),
    `and the frame is not reported as a client-side anomaly: ${app.posted().join(', ')}`);

  app.fire('state', { state: 'idle', requeued: true });
  await app.settle();
  assert.strictEqual(showing(v.history), false, 'a requeue wins over the screen');
  assert.strictEqual(showing(v.queue), true, 'with the queue view the player is actually in');
});
