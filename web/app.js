const KXP = window.KXP;
const SM = window.StateMachine;

let id = null;
// The server-issued player id (`pid`) names this browser across reloads and
// tabs; `id` names the SSE connection and is replaced whenever a newer stream
// connects. It is an identity, not a credential.
let pid = loadPid();
// The client's screen state. Kept in step with web/machine.js STATES, which owns
// the transitions; this list is only a reader's map of the names.
let state = 'lobby'; // lobby | waiting | matched | countdown | shoot | locked | result | ladder | history
let lastMode = 'online'; // online | cpu — mode of the finished match
// The CPU series length the lobby has selected, and the one the finished match
// actually played. Nothing here is a literal copy of the rules: the selection is
// read from the control that offers it -- or, when the player has a saved choice
// the control still offers (see the wiring below), from storage -- and a rematch
// repeats what the player just played rather than what the lobby happens to show
// now.
let cpuTarget = 0;
let cpuDrawEnds = false;
let lastTarget = 0;
let lastDrawEnds = null;
// The floor of the ladder match in progress, and -1 when the match is not a
// ladder match. The mode on the wire is `cpu` for both, so the distinction has to
// live here; the server has no ladder to know about.
let ladderFloor = -1;
// The (length, rule) pair a ladder run is fought at, captured from the lobby when
// the mode is entered and null when no run is in progress. It is the run's key:
// every floor repeats the length its run started at rather than the match that
// ended last, and two pairs keep two independent runs (see `readArcade`).
let ladderPair = null;
// What the result screen offers a ladder match: 'next', 'retry', 'done', or null
// when the match that ended was not a ladder match.
let ladderNext = null;
let pendingMode = null; // online | cpu — mode picked on the lobby, awaiting fighter confirmation
// Whether the player holds a challenge reservation. It decides what the invite
// screen shows: a reservation (true) puts the player's own code and the "search
// for anyone" fallback up, a plain matchmaker wait (false) hides both. Entering
// the waiting view is the one place it is read -- the create path sets it before
// the transition that would otherwise show a bare spinner, and a plain queue
// clears any code left from before.
let challengePending = false;
let es = null;
let shootTimer = null;
let remainingWindowMs = 2000; // local portion of the PUN window still open
let sawPunAt = 0;
let clockSkew = 0; // serverNow - clientNow, estimated from the connected snapshot
let stallTimer = null;
let slotTimer = null; // re-checks which countdown beat is due
let slotStep = null; // pure stepper for the round being counted down
let plannedShootAt = 0; // announced deadline (epoch-ms) slotStep belongs to
let punTimer = null; // local PUN entry scheduled from the announced round plan
// Buttons whose click is waiting on a server frame, and the one failsafe that
// re-arms them. See armPending.
let pendingButtons = [];
let pendingFailsafe = null;

// The series tally as the last result reported it. A CPU match is a series, so
// the score is the thing being played for and it has to outlive the round panel:
// resetGame hides the result panel when the next countdown starts, and the pips
// have to still be there. Null when the match has no series: a `matched` or a
// result without `roundsTarget` means exactly that, whether because the mode is
// PvP or because the server predates the field.
let seriesTally = null;

// Last-resort recovery: if a PUN result never arrives (dropped SSE event,
// wedged connection) we're stuck in a game state with nothing left to do.
// Reconnect so the server snapshot reconciles us out of it. The watchdog is
// only armed while a game view is live and disarms as soon as any transition
// leaves the active round.
function armStallWatchdog() {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    // Every live game state, not a shorter list re-derived here. `locked` is the
    // one that matters: a round resolves locally into `locked` seconds after
    // `shoot` and stays there until the result frame arrives, so a lost result is
    // a stall *in `locked`* -- the state the old two-state check declined.
    if (!GAME_STATES.includes(state)) return;
    if (DEBUG) console.warn('kxp: stalled in game state, re-syncing via reconnect');
    report('stalled', state);
    es.close();
    connect();
  }, 6000);
}

const DEBUG = /[?&]debug/.test(location.search);
const GAME_STATES = ['countdown', 'shoot', 'locked'];
const BGS = ['pool', 'forest', 'tomb', 'arena', 'portal'];

// Error beacon: fire-and-forget diagnostics when something the client sees
// goes wrong (stalled SSE, failed fetch, a transition the machine wouldn't
// take). Throttled by beaconGate upstream so a wedged link can't loop /report
// requests. Never blocks the tab; failures to send are ignored.
let lastBeacon = null;
function report(kind, state) {
  const now = Date.now();
  const g = KXP.beaconGate(kind, state, lastBeacon, now);
  lastBeacon = g.pass ? { ms: now, key: g.key } : lastBeacon;
  if (!g.pass || !id) return;
  post('/report', { kind, state, ts: now }).catch(() => {});
}

// bgReady resolves once the background for the current match is decoded and
// applied, so the game view is only shown when its bg can paint in one frame.
let bgReady = Promise.resolve(true);

// preloadBg returns a promise that resolves when the animated (and, for
// reduced-motion users, static) webp is decoded. It never rejects: a slow or
// missing asset must not hang the game screen, only defer it.
function preloadBg(bg) {
  const load = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = resolve;
    img.src = src;
  });
  return Promise.all([
    load(`/img/bg/${bg}.webp`),
    load(`/img/bg/${bg}-static.webp`),
  ]);
}

// setBg resolves the stage for an event and applies it. The server chooses (see
// backgrounds.md): it announces a name on `matched`, so both players are put in
// the same arena. The local fallback is what keeps that additive -- a client
// against a server predating the field still gets a stage, and a name we do not
// recognise would 404 on the asset rather than paint, so an unknown name falls
// back instead of being trusted.
function bgNameFor(d) {
  const want = d && d.background;
  if (want && BGS.includes(want)) return want;
  return BGS[Math.floor(Math.random() * BGS.length)];
}

function applyBg(bg) {
  return preloadBg(bg).then(() => {
    const r = document.documentElement.style;
    r.setProperty('--bg-anim', `url('/img/bg/${bg}.webp')`);
    r.setProperty('--bg-static', `url('/img/bg/${bg}-static.webp')`);
    return bg;
  });
}

function setBg(d) {
  const bg = bgNameFor(d);
  bgReady = applyBg(bg);
  // The name that was applied, for a caller that has to record which stage a
  // match was fought on. Every other caller ignores it.
  return bg;
}

// showGame defers showing the game view until the current bg is loaded. Guarded
// so a late load never paints the game screen after the player already left --
// which includes leaving into the match history: a stage still resolving while
// the record is open would otherwise replace it with a match that is over.
function showGame() {
  bgReady.then(() => {
    if (state !== 'lobby' && state !== 'waiting' && state !== 'history') show('game');
  });
}

const $ = (sel) => document.querySelector(sel);

let readyTimer = null;
// True while an arm is live. rAF cannot be cancelled, and `state` alone cannot
// tell a non-final result (the between-rounds gate is open) from a final one
// (the match is over) -- both are the `result` state -- so a frame queued by an
// earlier arm needs a way to find out that stop has superseded it.
let readyArmed = false;

function stopReadyLoop() {
  readyArmed = false;
  clearInterval(readyTimer);
  readyTimer = null;
}

function sendReady() { post('/ready'); }

// The ack waits for the announced background to decode *and* for a presented
// frame, in that order. The frame half is self-suppressing: rAF does not run in a
// backgrounded tab, so an app in the background never acknowledges and the
// server's timeout cancels the match instead of firing a round at somebody who is
// not there.
//
// The background half is not a nicety. Sequencing them matters more than it
// looks: rAF fires on the next paint of whatever is on screen, so without this
// the callback runs while the client is still showing the queue view and the
// background is still downloading -- the ack would go out and the countdown would
// begin with the match screen not yet up, which is the exact failure the
// background work was meant to remove.
//
// The ack proves presence, never attention. A phone propped up, screen awake and
// rendering, acknowledges happily while nobody is looking; nothing client-side
// can close that gap, because the server only ever sees an ack.
//
// The gate is a buffer, not a guarantee, and the cost is whatever a cancelled
// handshake costs: if the link is too slow to deliver an ack within the
// server's 8s at the opening, it cancels the pending match and sends
// `state idle`, which drops us back to the lobby with the reason shown; the
// same 8s between rounds of an online series ends the series instead, awarded
// to whichever side did answer. The ack it waits on is the same one either way.
function armReadyLoop() {
  // The span in which the server still accepts an ack: the opening handshake
  // (`matched`) and, for an online series, the pause between rounds, which the
  // client sits in as a non-final `result`. Outside that span the gate is
  // closed and the ack would be a claim about a round that will not run.
  if (state !== 'matched' && state !== 'result') return;
  readyArmed = true;
  // Behind bgReady, so the frame we wait for is a frame of the match screen
  // rather than of whatever was on screen while the background downloaded.
  // setBg() runs before this in every handler that reaches it, so bgReady is
  // already this match's promise by the time we chain onto it.
  bgReady.then(() => {
    // The match can end while the background is still loading; arming then would
    // ack a match that no longer exists.
    if (!readyArmed || (state !== 'matched' && state !== 'result')) return;
    const go = () => {
      if (!readyArmed || (state !== 'matched' && state !== 'result') || document.visibilityState === 'hidden') return;
      sendReady();
      // Clear without disarming: this arm's own interval is being replaced, and
      // stop -- the thing that invalidates a pending frame -- is not.
      clearInterval(readyTimer);
      readyTimer = setInterval(() => {
        if (!readyArmed || (state !== 'matched' && state !== 'result')) { stopReadyLoop(); return; }
        sendReady();
      }, 2000);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    else go();
  });
}

function show(view) {
  // The screen a pending button sits on is only now being left -- showGame
  // defers the swap behind the background decode -- so a button waiting on the
  // server is re-armed here, when its screen actually changes, not at the
  // transition that decided the move.
  clearPending();
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== view);
  });
  document.body.classList.toggle('in-game', view === 'game');
  if (view !== 'game') lockMoves();
}

function setCount(t) { $('#count').textContent = t; }

function setOnline(n) {
  const el = $('#online');
  if (n == null) { el.innerHTML = '&hellip;'; return; }
  el.innerHTML = `<span class="dot${n === 0 ? ' dim' : ''}"></span>${n} online now`;
}

function getStats() {
  try {
    const s = JSON.parse(localStorage.getItem('kxp-stats') || '{}');
    return {
      wins: Number(s.wins) || 0,
      streak: Number(s.streak) || 0,
      best: Number(s.best) || 0,
      last: Number(s.last) || 0,
    };
  } catch (e) {
    return { wins: 0, streak: 0, best: 0, last: 0 };
  }
}

function saveStats(s) {
  try { localStorage.setItem('kxp-stats', JSON.stringify(s)); } catch (e) {}
}

// The arcade ladder, client-side and persisted locally. The floors are the
// roster -- whatever GET /characters returned -- shuffled once per run, with the
// player's own character always last as the mirror match. Progression is the
// client's own state, so nothing here is authoritative: the server judges every
// round and is told which fighter to send out.
//
// A run is kept per (length, rule) pair -- the same pair the lobby control
// stores -- so switching the lobby's mode leaves the other one's run intact and
// each is resumable on its own. The pair *is* the run's length capture: a floor
// posts the length of the pair it is stored under, never the lobby's current
// selection.
const ARCADE_RUNS_KEY = 'kxp-arcade-runs';
// The pre-pair store: one run, no length of its own. Read once to migrate it
// (see adoptLegacyRun) and then removed, so it can never be read beside its
// replacement.
const ARCADE_KEY = 'kxp-arcade';
// One retry is banked for every this many floors won. A retry is a continue: a
// decided loss spends one to replay the floor rather than ending the run. It is
// a client constant because the lobby has no difficulty control; a value per
// difficulty is a later slice of the solo campaign. The bank is derived from
// `floorsCleared` rather than counted down as the floors are won, so this rate
// is the only place the number lives.
const ARCADE_RETRY_FLOORS = 2;

// Where the lobby remembers its chosen CPU series length, so a reload is not a
// change of heart. It holds the number, not a button: a control that no longer
// offers the stored length must fall back rather than post one nothing on screen
// matches (see the wiring below).
const CPU_LENGTH_KEY = 'kxp-cpu-length';

// The rule that went with that length. At a target of one the length cannot name
// the mode -- 1-off and first-to-1 are the same number -- so the choice is a
// (length, rule) pair, stored under two keys: the number keeps its old form
// (and its old readers), and this key holds the `'true'`/`'false'` string the
// button carries. A store without it predates the split and restores on length
// alone, which is the old meaning the stored length had.
const CPU_DRAWENDS_KEY = 'kxp-cpu-draw-ends';

// The map key for a pair. Draw ends is a boolean on the wire and in the button,
// but a key is a string, so it is folded to `1`/`0` rather than left to
// `String(true)`.
function pairKey(rounds, drawEnds) {
  return `${rounds}:${drawEnds ? '1' : '0'}`;
}

// The pair the lobby is currently showing. Read at the moment a run is entered
// (or the entry's label is drawn), never cached: the whole point of the map is
// that changing this selection changes which run is read.
function currentPair() {
  return { rounds: cpuTarget, drawEnds: cpuDrawEnds };
}

// readRuns is the runs map, with the pre-pair run migrated in on the way. The
// map is untrusted input -- writable by hand and outliving the code that wrote
// it -- so anything that is not an object is treated as empty.
function readRuns() {
  let runs = null;
  try { runs = JSON.parse(localStorage.getItem(ARCADE_RUNS_KEY) || '{}'); } catch (e) { runs = null; }
  if (!runs || typeof runs !== 'object' || Array.isArray(runs)) runs = {};
  // The migration has to be written back: readArcade reads the map and does not
  // save, so a run carried in memory and not persisted would vanish on the next
  // read -- the legacy key already removed.
  if (adoptLegacyRun(runs)) writeRuns(runs);
  return runs;
}

// adoptLegacyRun folds the single pre-pair run into the map, under the pair the
// saved lobby selection names -- the only pair it could have been fought at,
// since the old store had no length of its own. A store without the rule key
// predates the split, so a length of one restores as the 1-off it always meant.
// The legacy key is removed in the same breath, so the migration happens once
// even if the write below is refused.
function adoptLegacyRun(runs) {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(ARCADE_KEY) || 'null'); } catch (e) { legacy = null; }
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return false;
  const rounds = Number(localStorage.getItem(CPU_LENGTH_KEY)) || 1;
  const storedEnds = localStorage.getItem(CPU_DRAWENDS_KEY);
  const drawEnds = storedEnds === null ? rounds === 1 : storedEnds === 'true';
  const key = pairKey(rounds, drawEnds);
  // The map is the authority now: a pair that already has a run keeps it, and
  // the stray legacy key is only a leftover, not a newer run.
  if (!runs[key]) runs[key] = legacy;
  try { localStorage.removeItem(ARCADE_KEY); } catch (e) {}
  return true;
}

function writeRuns(runs) {
  try { localStorage.setItem(ARCADE_RUNS_KEY, JSON.stringify(runs)); } catch (e) {}
}

// readArcade returns the saved run for a pair, repaired against the current
// roster. A pair with no saved order is a first run, and draws one --
// deliberately not at startup, because the draw depends on which fighter the
// player has picked, and they pick it after the lobby is on screen.
function readArcade(pair) {
  // Whatever is in storage is untrusted: "null" and a bare number parse, so the
  // shape is checked rather than assumed -- anything that is not an object is a
  // first run.
  let s = readRuns()[pairKey(pair.rounds, pair.drawEnds)];
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  // A run whose fighters have all left the roster has no order left to keep.
  // Repairing it anyway would hand back the roster in server order -- the one
  // thing the draw exists to avoid, since every first run would then be identical
  // and start with the same fighter. That is a first run, not a repaired one.
  const repaired = Array.isArray(s.order) ? repairOrder(s.order) : null;
  const fresh = !repaired || !repaired.length;
  const order = fresh ? drawOrder() : repaired;
  // A fresh ladder starts at the bottom: the stored floor is a position in an
  // order that is gone, so keeping it would drop the player onto the top floor of
  // a ladder they have not climbed.
  const floor = fresh ? 0
    : Math.min(Math.max(Number(s.floor) || 0, 0), order.length - 1);
  // Cleared is a fact about the run -- the mirror is down -- not a position in the
  // order, so it survives a repair and does not survive a redraw. The retry
  // bookkeeping is the same kind of fact: a run keeps the floors it has won and
  // the retries it has spent across a repair, and a redraw is a new run that
  // starts with none.
  return {
    order,
    floor,
    cleared: !fresh && !!s.cleared,
    floorsCleared: fresh ? 0 : Math.max(0, Number(s.floorsCleared) || 0),
    retriesSpent: fresh ? 0 : Math.max(0, Number(s.retriesSpent) || 0),
    lostLast: !fresh && !!s.lostLast,
  };
}

function saveArcade(pair, a) {
  const runs = readRuns();
  runs[pairKey(pair.rounds, pair.drawEnds)] = a;
  writeRuns(runs);
}

// discardArcade forgets one pair's run: the next readArcade for that pair draws
// a new ladder. A loss ends the run this way -- the only caller left. Changing
// the lobby's mode no longer discards anything, because a run belongs to the
// pair it was started at and the other pair's run is still the player's.
function discardArcade(pair) {
  const runs = readRuns();
  delete runs[pairKey(pair.rounds, pair.drawEnds)];
  writeRuns(runs);
}

// drawOrder is a fresh run: the roster, shuffled, with the mirror last. The
// player's own character is excluded from the shuffle and appended, so it is the
// final floor exactly once whatever the draw did with the rest.
function drawOrder() {
  const me = loadCharacter();
  const rest = shuffle(CHARACTERS.map((c) => c.id).filter((id) => id !== me));
  return CHARACTERS.some((c) => c.id === me) ? rest.concat([me]) : rest;
}

// repairOrder makes a saved order a valid ladder again after the roster changed,
// without reshuffling what the player has already climbed: stored fighters still
// on the roster keep their positions, roster fighters the run never mentioned are
// appended ahead of the mirror, and the mirror goes last. Discarding the order
// instead would silently drop a run in progress to the bottom, and trusting it
// would point a floor at a fighter that no longer exists.
function onRoster(id) {
  return CHARACTERS.some((c) => c.id === id);
}

function repairOrder(stored) {
  const me = loadCharacter();
  if (!stored.some(onRoster)) return null;
  const kept = stored.filter((id) => onRoster(id) && id !== me);
  const missing = CHARACTERS.map((c) => c.id).filter((id) => id !== me && kept.indexOf(id) === -1);
  return CHARACTERS.some((c) => c.id === me) ? kept.concat(missing, [me]) : kept.concat(missing);
}

// Fisher-Yates. Math.random is fine here: the order is the client's own, and a
// test asserts the properties of the draw (every fighter once, the mirror last)
// rather than a particular sequence.
function shuffle(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// The retries a run is holding: one banked per ARCADE_RETRY_FLOORS floors won,
// minus the ones already spent. Derived rather than stored as a running count,
// so a repair or a hand-edited store cannot leave the bank disagreeing with the
// floors the run actually cleared.
function retryBank(a) {
  return Math.max(0, Math.floor(a.floorsCleared / ARCADE_RETRY_FLOORS) - a.retriesSpent);
}

// advanceLadder moves the run on after a ladder match has been decided and says
// which floor is next. A win climbs one floor; a loss ends the run unless a
// retry is banked, in which case it offers to replay the same floor. A drawn
// floor is neither: the floor's request always says its drawers replay (drawEnds:
// false), so a draw against an honouring server replays and never reaches a
// result here -- the branch exists as the client-side half of the same rule, that
// an outcome which cannot decide a floor must not be able to reset one. It reads
// and writes the run with the same repair on the way in, so a ladder that crossed
// a deploy which changed the roster progresses on the repaired order rather than
// on one that is no longer valid.
//
// Returns what the result screen should offer, since the honest label differs:
// the next floor after a win, the same floor again after a draw, a spent retry
// after a loss that was survived, and a new ladder after a loss that was not or
// once the mirror is down.
function advanceLadder(outcome) {
  const a = readArcade(ladderPair);
  if (outcome === 'win') {
    a.floorsCleared += 1;
    a.lostLast = false;
    if (a.floor >= a.order.length - 1) {
      // The mirror is down. The run stays where it is and says it is cleared,
      // rather than the floor wrapping to zero and the ladder reading as a run in
      // progress that has already been beaten -- which is what the entry would
      // otherwise offer to resume.
      a.cleared = true;
      a.floor = 0;
      saveArcade(ladderPair, a);
      return 'done';
    }
    a.floor += 1;
  } else if (outcome === 'loss') {
    // A banked retry is a continue: the run stays on the floor it lost and is
    // marked so the replay can spend the retry. With nothing banked the run ends
    // as it always did -- discarded, the floor forgotten, so the next entry draws
    // a new ladder and the tower opens at the bottom rather than animating a drop
    // onto a ladder the player no longer has.
    if (retryBank(a) > 0) {
      a.lostLast = true;
      saveArcade(ladderPair, a);
      return 'retry-loss';
    }
    discardArcade(ladderPair);
    ladderFloor = -1;
    return 'done';
  } else {
    a.cleared = false;
    saveArcade(ladderPair, a);
    return 'retry-floor';
  }
  a.cleared = false;
  saveArcade(ladderPair, a);
  return 'next';
}


// The lobby's Arcade Mode entry. Read-only -- resuming is a stored order, not a
// flag, so this never draws. It reads the run for the pair the lobby is showing,
// which is why switching the length control re-labels it: each pair has its own
// run and its own answer.
function setLadderEntry() {
  const btn = $('#btn-ladder');
  if (!btn) return;
  const a = readArcade(currentPair());
  btn.disabled = !CHARACTERS.length;
  // A cleared ladder has nothing to resume, so the entry says it will draw a new
  // one. Leaving the label alone would have the player pick a fighter and be told
  // there is nothing to fight.
  btn.textContent = a.cleared ? 'New Arcade Mode' : 'Arcade Mode';
}

// The tower: the run drawn as the ladder it is. One row per floor, in the order
// the floors are fought, with the player standing on the floor the run is on --
// right beside the fighter they are about to meet, or the one they just beat.
//
// Two things are decided here rather than left to the CSS. Where the player
// stands: a cleared run stands at the top, because its floor was reset to zero so
// the entry would not treat a beaten ladder as one to resume, and the tower is
// the one place that is not true. And which way the climb went, from the floor
// just fought to the floor the run moved to -- `ladderFloor` is the only record of
// where the player came from, since the run stores where they are.
//
// The rows are the whole order rather than a window onto it, and the markup is in
// match order with CSS laying it out bottom-up: a ladder that showed only the next
// few floors would be a list, and seeing how far is left is the point of climbing.
function showTower() {
  const a = readArcade(ladderPair);
  const me = characterByID(loadCharacter());
  const pos = a.cleared ? a.order.length - 1 : a.floor;
  const hop = ladderFloor >= 0 && ladderFloor !== pos
    ? (pos > ladderFloor ? ' climb' : ' climb-down') : '';
  $('#ladder-tower').innerHTML = a.order.map((id, i) => {
    const c = characterByID(id);
    // Below the player is what has been beaten; above it is what has not. A
    // fighter that has left the roster still draws its row: the ladder was drawn
    // from the roster as it was, and dropping the row would renumber the floors
    // under a run in progress.
    const foe = c ? `${c.emoji} ${c.name}` : '\u2014';
    const meRow = i === pos
      ? `<span class="climber${hop}"><span class="climber-emoji">${me ? me.emoji : ''}</span>you</span>`
      : '';
    return `<div role="listitem" class="floor${i < pos ? ' cleared' : ''}${i === pos ? ' here' : ''}" data-floor="${i}"><span class="floor-no">${i + 1}</span><span class="floor-foe">${foe}</span>${meRow}</div>`;
  }).join('');
  $('#ladder-title').textContent = a.cleared
    ? 'Arcade complete'
    : `Floor ${pos + 1} of ${a.order.length}`;
  const btn = $('#ladder-fight');
  btn.textContent = a.cleared ? 'New Arcade Mode' : `Fight Floor ${pos + 1}`;
  // Armed on every render: the button disarms itself while its request is in
  // flight, and the next floor arrives by showing the tower again, so nothing
  // else would put it back.
  btn.disabled = false;
  show('ladder');
}

// The match history: this browser's own record of the matches it finished, one
// entry per match, newest first, capped like any other local store. The server
// keeps no history -- nothing in this repo could -- so this is the client's own,
// and it is read the way the arcade ladder's run is: whatever is in localStorage
// is writable by hand and outlives the code that wrote it, so the shape is
// checked rather than assumed.
//
// It is not a leaderboard, deliberately. Ranking needs something a per-browser
// array cannot give, which is why the ladder is gated on player identity and
// this is not: a record of what this device finished is honest about being
// exactly that.
const HISTORY_KEY = 'kxp-history';
const HISTORY_CAP = 50;

const OUTCOMES = ['win', 'loss', 'draw', 'void'];
const OUTCOME_LABELS = { win: 'Win', loss: 'Loss', draw: 'Draw', void: 'No contest' };

// What the record of the match in progress is filed under -- the opponent, the
// length, the stage, all read from `matched` -- and the rounds of that match as
// they resolve. The record spans a whole match; every frame that feeds it
// describes one round, and the two are kept together for the same reason the
// opponent slot is: what a frame says about its round is only a row of
// something bigger.
//
// The context earns its place on what a deciding frame does not carry. An
// opponent's departure never carries the stage, the plain form of one (a
// departure before anything was scored) carries no series fields at all, and
// the identity pair rides that frame today only because the wire grew it later
// -- a client that must also survive a server predating it reads the pair from
// here first.
let matchCtx = null;
let pendingRounds = [];

// readHistory returns the matches recorded here, newest first, capped on the
// way in rather than trusted to have been capped on the way out.
function readHistory() {
  let list = null;
  try { list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { list = null; }
  if (!Array.isArray(list)) return [];
  return list.filter(historyOK).slice(0, HISTORY_CAP);
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_CAP))); } catch (e) {}
}

// What a stored entry must have to be rendered. The fighters, the stage and the
// tally read with honest fallbacks on the way out, so requiring them here would
// drop an entry an older client wrote for a good reason; these are the fields
// neither the summary nor the rounds can read without.
function historyOK(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (!OUTCOMES.includes(e.outcome) || (e.mode !== 'online' && e.mode !== 'cpu')) return false;
  if (!Number.isFinite(e.ts) || !Array.isArray(e.rounds)) return false;
  return e.rounds.every((r) => r && typeof r === 'object'
    && Number.isFinite(r.round) && OUTCOMES.includes(r.outcome));
}

// recordRound files what this frame says about the round onto the match in
// progress. A frame that names no round is not a round anybody played, so it
// becomes one only when nothing else is recorded: a departure the match opened
// and closed on is still a row worth showing, while a forfeited series must not
// grow a round nobody won.
function recordRound(d) {
  const n = Number(d.round);
  // Round one starts a new record. The round number is the one thing on a frame
  // that says which match it belongs to -- all a client has if its server was
  // restarted under it, or it was reconnected into a match it was not playing.
  if (n === 1) pendingRounds = [];
  const unnamed = !Number.isFinite(n);
  if (unnamed && pendingRounds.length) return;
  pendingRounds.push({
    round: unnamed ? pendingRounds.length + 1 : n,
    you: d.you || '',
    opponent: d.opponent || '',
    yourNote: d.yourNote || '',
    opponentNote: d.opponentNote || '',
    // What this client measured about its own click beats the round trip when it
    // reported one, exactly as the result panel reads them; a side that cannot
    // say is left blank rather than given a number it did not produce.
    youMs: d.youClientMs ?? d.youTimingMs ?? null,
    opponentMs: d.opponentClientMs ?? d.opponentTimingMs ?? null,
    outcome: d.outcome,
    // Only a departure writes this: the sentence the banner shows for one. It is
    // what a row falls back to when there are no moves to show.
    note: d.note || '',
    ts: Number(d.ts) || Date.now(),
  });
}

// commitMatch files the match whose deciding frame has just arrived, and clears
// what was waiting to be filed with it. `seriesOver !== false` is the arcade
// ladder's rule and the Play Again button's, so history, the ladder and the
// result screen agree on what "decided" means -- and a server predating the
// field records rather than leaving the match unrecorded.
function commitMatch(d) {
  const ctx = matchCtx || {};
  saveHistory([{
    outcome: d.outcome,
    // The wire's closed set, collapsed to it: an unrecognised mode would be
    // dropped on the next read, which would lose a real match to a stray value.
    mode: d.mode === 'cpu' ? 'cpu' : 'online',
    youCharacter: d.youCharacter || loadCharacter() || null,
    opponentCharacter: d.opponentCharacter || ctx.opponentCharacter || null,
    opponentName: d.opponentName || ctx.opponentName || null,
    roundsTarget: Number(d.roundsTarget) || ctx.roundsTarget || 0,
    youRoundWins: d.youRoundWins != null ? Number(d.youRoundWins) : null,
    oppRoundWins: d.oppRoundWins != null ? Number(d.oppRoundWins) : null,
    background: ctx.background || null,
    rounds: pendingRounds.slice(),
    ts: Number(d.ts) || Date.now(),
  }, ...readHistory()]);
  matchCtx = null;
  pendingRounds = [];
}

// historyEmoji names a fighter by its roster emoji alone, from what the record
// holds. Deliberately not characterByID, which falls back to the roster's first
// fighter and would draw somebody else's emoji for a fighter that has since left
// the roster: a stored id the roster no longer knows still reads as itself, and
// only nothing at all reads as a dash.
function historyEmoji(id, fallback) {
  const c = id && CHARACTERS.find((f) => f.id === id);
  if (c) return c.emoji;
  return id || fallback || '\u2014';
}

// One line per match, and only what a glance needs: when it was played, whether
// it was CPU or online, the two fighters as emojis, and the result. The full
// names, the stage and the series tally are not repeated here -- the collapsed
// row stays short, and what was actually played is one tap away in the row it
// expands into.
function historySummary(e) {
  const bits = [
    KXP.whenLabel(e.ts, Date.now()),
    e.mode === 'cpu' ? 'CPU' : 'Online',
    `${historyEmoji(e.youCharacter, 'You')} vs ${historyEmoji(e.opponentCharacter, e.opponentName)}`,
    OUTCOME_LABELS[e.outcome] || '\u2014',
  ];
  return bits.join(' \u00b7 ');
}

// One round inside it. The moves go up as both sides' picks when there are any,
// and the departure's sentence when there are not -- a row that showed a dash
// against a dash would say less than the frame it came from.
function historyRound(r) {
  const bits = [`<span class="hist-rn">R${r.round}</span>`];
  if (r.note) bits.push(r.note);
  else if (r.you || r.opponent) bits.push(`${KXP.aliases[r.you] || '\u2014'} vs ${KXP.aliases[r.opponent] || '\u2014'}`);
  bits.push(`<span class="hist-outcome hist-${r.outcome}">${OUTCOME_LABELS[r.outcome] || '\u2014'}</span>`);
  // The round's own notes -- timed out, early, late -- mine first and theirs
  // second, the order the timings below are in.
  const notes = [r.yourNote, r.opponentNote].filter(Boolean);
  if (notes.length) bits.push(`<span class="hist-note">${notes.join('/')}</span>`);
  if (r.youMs != null || r.opponentMs != null) {
    bits.push(`<span class="hist-ms">${r.youMs ?? '\u2014'}/${r.opponentMs ?? '\u2014'}ms</span>`);
  }
  return `<li class="hist-round">${bits.join(' \u00b7 ')}</li>`;
}

function historyHTML(e) {
  const stage = e.background
    ? `<p class="hist-stage">${e.background[0].toUpperCase()}${e.background.slice(1)}</p>` : '';
  return `<details class="hist-match hist-${e.outcome}">`
    + `<summary>${historySummary(e)}</summary>`
    + `<div class="hist-body">${stage}<ol class="hist-rounds">${e.rounds.map(historyRound).join('')}</ol></div>`
    + `</details>`;
}

// renderHistory draws the record when it is opened, rather than keeping it in
// step as it grows: it is this browser's own, and reading it here is what makes
// a match committed a moment ago -- or by another tab -- visible without a
// reload. Stored strings go into the markup the way every other render in this
// file puts them, as the roster and the server supply them on the way in.
function renderHistory() {
  const list = readHistory();
  $('#history-list').innerHTML = list.length
    ? list.map(historyHTML).join('')
    : '<p class="hist-empty">No matches yet.</p>';
}

function setStats() {
  const s = getStats();
  const text = `Wins: ${s.wins} \u00b7 Streak: ${s.streak} \u00b7 Last: ${s.last} \u00b7 Best: ${s.best}`;
  const el = $('#stats');
  if (el) el.textContent = text;
  const g = $('#game-stats');
  if (g) g.textContent = text;
}

function renderFighters() {
  const pick = loadCharacter();
  if (!CHARACTERS.length) {
    $('#fighters').innerHTML = '';
    return;
  }
  $('#fighters').innerHTML = CHARACTERS.map((c) => `
    <button class="fighter${c.id === pick ? ' selected' : ''}" data-char="${c.id}" aria-label="${c.name}">
      <span class="fighter-emoji">${c.emoji}</span>
      <span>${c.name}</span>
    </button>
  `).join('');
}

function openChoose(mode) {
  pendingMode = mode;
  // Online is invite-first: the confirm mints a reservation rather than joining
  // the matchmaker, so the button says what it does.
  $('#btn-start').textContent = mode === 'online' ? 'Create Invite' : 'Fight!';
  $('#btn-start').disabled = false;
  if (CHARACTERS.length && !localStorage.getItem('kxp-character')) {
    saveCharacter(CHARACTERS[0].id);
  }
  renderFighters();
  show('choose');
}

// Put a reservation's code on the invite screen. The code is the token in a
// /?challenge= URL: the same string a friend pastes back into the field, or taps
// as a link. Setting the flag here -- before the transition into waiting -- is
// what keeps the screen from showing a bare spinner over the code just made.
function showInvite(token) {
  const inp = document.getElementById('challenge-url');
  if (inp) inp.value = location.origin + '/?challenge=' + encodeURIComponent(token);
  challengePending = true;
}

// Mint a fresh challenge reservation and move to the invite screen on a 200.
// The lobby's confirm and Play Again's online rematch post the same request and
// both answer a 200 the same way; they differ only in which transition follows
// and in what a refusal restores, so those are the parameters. The caller arms
// its own button -- entering the invite screen re-arms it (see show).
function mintChallenge(pair, event, onRefuse) {
  post('/challenge', pair).then((res) => {
    if (res && res.ok) {
      showInvite((res.data || {}).token);
      transition(event);
      return;
    }
    clearPending();
    if (onRefuse) onRefuse(res);
  });
}

// The token out of whatever the player pasted: a full /?challenge= URL or a bare
// token. The link is opaque and carries no format beyond its path, so the only
// thing to strip is the surrounding URL when one was pasted.
function tokenFromPaste(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/[?&]challenge=([^&\s]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  return s;
}

// Put the invite URL on the clipboard. execCommand is the copy that needs no
// permission prompt, and the select() is what the command copies from; it is the
// fallback for a browser with no share sheet and for a dismissed one.
function copyInvite() {
  const inp = document.getElementById('challenge-url');
  if (!inp) return;
  inp.select();
  try { document.execCommand('copy'); } catch (e) {}
}

// Paint the invite screen from the reservation flag. Called on entering the wait
// and when "search for anyone" leaves the reservation without leaving the screen.
function renderInvite() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const link = document.getElementById('challenge-link');
  if (link && link.classList) link.classList.toggle('hidden', !challengePending);
  const search = document.getElementById('btn-search');
  if (search && search.classList) search.classList.toggle('hidden', !challengePending);
  const title = document.getElementById('queue-title');
  if (title) title.textContent = challengePending ? 'Invite a friend' : 'Searching for an opponent\u2026';
}

// The inline failure line beside the paste field. A bad code must leave the
// screen usable rather than bounce the player to the lobby, so the message lives
// here instead of the shared notice.
function setClaimError(msg) {
  const el = document.getElementById('claim-error');
  if (!el) return;
  el.textContent = msg || '';
  if (el.classList) el.classList.toggle('hidden', !msg);
}

function fighterHTML(charId, role) {
  const c = characterByID(charId);
  const tag = `<span class="slot-tag">(${role})</span>`;
  if (!c) return tag;
  return `<span class="slot-emoji">${c.emoji}</span><span class="slot-name">${c.name}</span>${tag}`;
}

function setYouSlot() {
  $('#you-slot').innerHTML = fighterHTML(loadCharacter(), 'you');
}

function setOppSlot(charId, name) {
  const role = (name || 'opponent').toLowerCase();
  const c = charId && characterByID(charId);
  if (c) {
    $('#opp-slot').innerHTML = fighterHTML(charId, role);
  } else {
    $('#opp-slot').innerHTML = `<span class="slot-tag">(${role})</span>`;
  }
}

function lockMoves() {
  document.querySelectorAll('.move').forEach((b) => { b.disabled = true; });
  $('#stage').classList.remove('go');
}

function enableMoves() {
  document.querySelectorAll('.move').forEach((b) => { b.disabled = false; });
}

function flashPick(move) {
  document.querySelectorAll('.move').forEach((b) => {
    b.classList.toggle('picked', b.dataset.move === move);
  });
}

function resetGame() {
  clearTimeout(shootTimer);
  clearTimeout(slotTimer);
  clearTimeout(punTimer);
  slotTimer = null;
  punTimer = null;
  slotStep = null;
  plannedShootAt = 0;
  sawPunAt = 0;
  $('#banner').classList.add('hidden');
  $('#timing').classList.add('hidden');
  $('#game-stats').classList.add('hidden');
  $('#you-pips').classList.add('hidden');
  $('#opp-pips').classList.add('hidden');
  ladderNext = null;
  $('#btn-again').textContent = 'Play Again';
  $('#btn-again').classList.add('hidden');
  $('#btn-mode').classList.add('hidden');
  flashPick(null);
  setCount('\u200b');
}

// v1.1: the server pre-announces the PUN deadline (shootAt) on the countdown
// frame, so KA/CHI/PUN can be scheduled on the client clock. A dropped or
// stalled `shoot` frame can then no longer cost the round — the countdown
// itself ends at the announced time via a local timer. A `shoot` frame that
// arrives anyway just enters a window we already opened (the machine ignores
// it in the shoot state).
function tick() {
  if (state !== 'countdown' || !slotStep) return;
  const due = slotStep();
  if (due.label) setCount(due.label);
  if (due.wait > 0) slotTimer = setTimeout(tick, due.wait);
}

function planFromCountdown(d) {
  if (!d.shootAt) return; // pre-announce unseen — fall back to frame-driven play
  // Every countdown frame re-arms the painter and the PUN timer, repeats
  // included. They all carry this same shootAt, and skipping them is what let one
  // bad clock reading blank the whole countdown: the chain below was built from
  // the first frame and the rest could not correct it. Re-arming is invisible --
  // the painter repaints only when the due beat changes -- and each re-arm
  // re-derives from the clock as it is now rather than from whenever the round
  // was first announced.
  clearTimeout(slotTimer);
  clearTimeout(punTimer);
  const plan = KXP.planRound(Date.now(), d.shootAt, d.windowMs, clockSkew);
  // Every frame re-derives what is due, repeats included, so a clock that read
  // wrong a moment ago is corrected by the next frame rather than waited out.
  // One stepper per round keeps its memory of the last painted beat, so
  // re-deriving does not repaint the label already on screen.
  if (!plan) return;
  // The deadline decides what is on screen, not the frame that named it. A
  // countdown frame that arrives late must not paint a beat with no time behind
  // it: that beat would be overwritten in the same tick by an already-due
  // transition, so the count would jump straight to PUN and the player would
  // see no countdown at all even though the server had announced one and the
  // pick window was still open. The painter shows whichever beat is genuinely
  // still ahead, so a frame delayed past its own beat degrades to the next real
  // beat instead of flashing a dead one -- and re-reads the clock on every tick,
  // so a phone whose wall clock steps recovers within a tick instead of waiting
  // out a timer scheduled from the bad reading.
  if (d.shootAt !== plannedShootAt) {
    plannedShootAt = d.shootAt;
    slotStep = KXP.countdownPainter(() => Date.now(), d.shootAt, d.windowMs, () => clockSkew);
  }
  clearTimeout(slotTimer);
  tick();
  if (plan.actionable) {
    punTimer = setTimeout(() => {
      if (state !== 'countdown') return;
      transition('shoot', { shootAt: d.shootAt, windowMs: d.windowMs || remainingWindowMs });
    }, Math.max(0, plan.msUntilPun));
  }
}

function banner(html) {
  $('#banner').innerHTML = html;
  $('#banner').classList.remove('hidden');
}

function renderResult(d) {
  const cls = d.outcome === 'win' ? 'won' : d.outcome === 'loss' ? 'lost' : 'draw';
  const lbl = d.note || (d.outcome === 'win' ? 'You win!' : d.outcome === 'loss' ? 'You lose' : 'Draw!');
  banner(`<p class="${cls}">${lbl}</p>`);

  const lines = KXP.resultLines(d);
  $('#timing').innerHTML = lines.join('<br>');
  $('#timing').classList.toggle('hidden', lines.length === 0);
  $('#game-stats').classList.remove('hidden');
  // A round that is not the last is not a finished match: offering "Play Again"
  // here is what made a series look like it had ended after round one, and the
  // player pressing it would abandon a match still being played. The series
  // fields are additive, so a server that predates them (an open tab across a
  // deploy) sends none and every result is final, which is what `!== false` says.
  const over = d.seriesOver !== false;
  if (over) {
    $('#btn-again').classList.remove('hidden');
    $('#btn-again').disabled = false;
    // A ladder match offers the next floor rather than "the same match again",
    // because it is not the same match: it is a different fighter, and the button
    // saying otherwise would be the one piece of the ladder a player never sees.
    if (ladderNext) {
      $('#btn-again').textContent = ladderNext === 'done' ? 'New Arcade Mode'
        : ladderNext === 'retry' ? 'Back to Floor 1'
        : ladderNext === 'retry-floor' ? 'Retry This Floor'
        : ladderNext === 'retry-loss' ? 'Use Retry' : 'Next Floor';
    }
    $('#btn-mode').classList.remove('hidden');
  }
  renderPips(d.youRoundWins, d.oppRoundWins, d.roundsTarget, d.drawEnds);
  setYouSlot();
  setOppSlot(d.opponentCharacter, d.opponentName);
}

// The series scoreboard: one pip per round win a side still needs, filled as it
// takes them. Driven by the server's roundsTarget and drawEnds rather than a
// count written here, so the row is exactly as long as the series is and the
// client holds no copy of the rules.
//
// Only for a series that can span rounds. A match that cannot go past round one
// -- a 1-off (drawEnds: true), or a server that reports no rule, which is read
// as the 1-off an absent field has always meant -- has no running tally to
// show. first-to-1 is the exception at a target of one: it can span rounds
// precisely because a drawn round replays, so its single pip is the thing a
// draw leaves behind, the empty row the old "cutoff at two" rule could not say.
function renderPips(you, opp, target, drawEnds) {
  const ends = drawEnds !== undefined ? drawEnds : (target || 0) <= 1;
  seriesTally = target > 1 || (target && !ends) ? { you, opp, target } : null;
  paintPips();
}

// Repaint from the remembered tally, after resetGame has cleared the panel the
// pips live beside. A series spans rounds, and the score the player just earned
// has to still be on screen while the next round counts down.
function paintPips() {
  const s = seriesTally;
  paintPipRow('#you-pips', s ? s.you : 0, s ? s.target : 0);
  paintPipRow('#opp-pips', s ? s.opp : 0, s ? s.target : 0);
}

function paintPipRow(sel, wins, target) {
  const el = $(sel);
  el.innerHTML = target > 0 ? pipHTML(wins, target) : '';
  el.classList.toggle('hidden', target === 0);
}

// Filled pips lead, left to right: the row reads as filling up rather than as a
// count, which is the whole point of drawing it.
function pipHTML(wins, target) {
  let out = '';
  for (let i = 0; i < target; i++) out += `<span class="pip${i < wins ? ' on' : ''}"></span>`;
  return out;
}

// postCPU starts a CPU match. A ladder floor names the fighter it is climbed
// against; a plain CPU match does not, and lets the server pick. The ladder's
// order is saved *before* the request, so a reload mid-climb resumes the same
// ladder rather than drawing a new one under the player.
function postCPU(mode) {
  if (mode !== 'ladder') {
    ladderFloor = -1;
    return post('/cpu', { roundsTarget: cpuTarget, drawEnds: cpuDrawEnds });
  }
  // The floor is fought at the pair its run was entered under, never the lobby's
  // current selection: switching the control mid-run moves to a different run,
  // and a floor must always be the length its own run started at.
  const a = readArcade(ladderPair);
  // A replay after a loss is the retry being taken. It is spent here, where the
  // floor is actually re-fought, so the result screen's "Use Retry" and a resume
  // from the lobby cannot spend it twice or decline to -- both arrive at this
  // request. `lostLast` is only set with a banked retry; a hand-edited store that
  // lost the bank is cleared rather than trusted into a negative one.
  if (a.lostLast) {
    if (retryBank(a) > 0) a.retriesSpent += 1;
    a.lostLast = false;
  }
  // A cleared run -- or a stored position past the end of the order, which the
  // clamp cannot produce but a hand-edited store can -- starts a new ladder. This is
  // the only redraw, so both the result screen's "New Arcade Mode" and the lobby's entry
  // go through it, and neither can leave a player with nothing to do. The retry
  // bookkeeping is reset with the order: a new run has won nothing yet.
  if (a.cleared || a.floor >= a.order.length) {
    a.order = drawOrder();
    a.floor = 0;
    a.cleared = false;
    a.floorsCleared = 0;
    a.retriesSpent = 0;
    a.lostLast = false;
  }
  ladderFloor = a.floor;
  saveArcade(ladderPair, a);
  // A floor is never 1-off: drawn rounds replay, so a draw can never decide a
  // floor. The server defaults a one-round request to "end on a draw", which is
  // exactly what a 1-off CPU match wants, so the ladder has to say otherwise --
  // whatever the run's own pair says its draw rule is.
  return post('/cpu', { roundsTarget: ladderPair.rounds, opponentCharacter: a.order[a.floor], drawEnds: false });
}

async function post(path, body = {}) {
  if (!id) return null;
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    });
    // Parse once and hand back both the verdict and the body: an endpoint's
    // reply is a request's own data (a challenge's token), and a caller that
    // wants it must not have to re-read a Response this helper already consumed.
    let data = null;
    try { data = await resp.json(); } catch (e) {}
    return { ok: resp.ok, status: resp.status, error: (data && data.error) || '', data };
  } catch (e) {
    report('fetch-error', state);
    return null;
  }
}

// A button whose click is awaiting a server frame. Play Online, Instant CPU and
// the tower's fight post a request, but success is signalled by a later SSE
// frame rather than by the reply: the button is disabled from the click until
// that frame arrives. Left bare the wait reads as inert, and a frame that never
// comes leaves the button dead with no way back. Marking it pending makes the
// wait read as working, and one failsafe re-arms it if the reply never lands --
// a dropped event costs the player a retry, not the screen.
const PENDING_FAILSAFE_MS = 8000;
function armPending(btn) {
  if (!btn || pendingButtons.indexOf(btn) >= 0) return;
  btn.disabled = true;
  btn.classList.add('pending');
  pendingButtons.push(btn);
  clearTimeout(pendingFailsafe);
  pendingFailsafe = setTimeout(clearPending, PENDING_FAILSAFE_MS);
}

// Every pending button, or the one named. Called when a frame moves the screen
// on (the awaited reply arrived), when a request is refused (the player may try
// again), and by the failsafe above.
function clearPending() {
  clearTimeout(pendingFailsafe);
  pendingFailsafe = null;
  for (const b of pendingButtons) {
    b.classList.remove('pending');
    b.disabled = false;
  }
  pendingButtons = [];
}

// Arm a button for a request whose success a later SSE frame confirms, and re-arm
// it if the request is refused instead (a non-ok reply or a dropped fetch). That
// arm-post-clear shape is the shared preamble of the CPU, tower, and rematch
// entries. onRefuse runs after the re-arm, e.g. to restore what the press was
// for, so a rejection reads as the same tap still pending rather than as a fresh
// one.
function postPending(btn, promise, onRefuse) {
  armPending(btn);
  Promise.resolve(promise).then((res) => {
    if (res && res.ok) return;
    clearPending();
    if (onRefuse) onRefuse(res);
  });
}

function transition(ev, data) {
  const to = SM.next(state, ev);
  if (!to) {
    // An event the state machine rejected: a frame arriving out of order (or
    // for the wrong phase) that the client silently dropped. Worth surfacing
    // as a beacon — it is the exact signature behind "stuck" symptoms.
    if (DEBUG) console.warn(`kxp: no transition ${state} + ${ev}`);
    report('bad-transition', state);
    return false;
  }
  const from = state;
  state = to;
  if (enter[to]) enter[to](data || {}, from);
  return true;
}

// Copy for a cancelled handshake. State only what the server can prove — the
// handshake did not complete in time, or the other side left — and never which
// player was responsible: the server observes an ack that never arrived, which is
// equally consistent with a slow upload, a stalled connection, or a device that
// slept. An unrecognised reason shows nothing rather than leaking the raw value.
const CANCEL_NOTES = {
  'handshake-timeout': 'Ready wasn’t confirmed in time — match cancelled. Both sides tap Ready to start.',
  'opponent-left': 'Opponent left before the round started.',
};

function setNotice(reason) {
  const el = $('#notice');
  if (!el) return;
  const text = reason ? CANCEL_NOTES[reason] : '';
  // textContent, not innerHTML: the reason is server-generated today, and this
  // keeps it that way if it ever becomes client-supplied.
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

const enter = {
  lobby(d) {
    stopReadyLoop();
    clearTimeout(stallTimer);
    resetGame();
    ladderFloor = -1;
    ladderPair = null;
    setLadderEntry();
    // The match is over -- finished, cancelled or abandoned -- so the series it
    // belonged to is too, and the next one starts from empty pips.
    seriesTally = null;
    paintPips();
    // ...and so is what was being recorded of it. An unfinished match is not a
    // record of anything, so a match abandoned mid-series leaves nothing behind
    // and the next one starts a record of its own rather than inheriting the
    // rounds of a match that never finished.
    matchCtx = null;
    pendingRounds = [];
    // The wait is over -- cancelled, claimed, or its match finished -- so the
    // next queue screen is a plain one unless a new link is created.
    challengePending = false;
    show('lobby');
    setNotice(d && d.reason);
  },

  waiting(d) {
    stopReadyLoop();
    clearTimeout(stallTimer);
    show('queue');
    // Whether the screen shows the player's own code and the "search for anyone"
    // fallback is read here, the one entry both paths reach: a reservation keeps
    // them up across the transition that would otherwise hide the code, and a
    // plain queue hides any left from before.
    renderInvite();
    // A plain /queue has no reason, so this clears any notice left over from an
    // earlier cancelled handshake rather than stranding it above the spinner.
    setNotice(d && d.reason);
  },

  matched(d) {
    stopReadyLoop();
    clearTimeout(stallTimer);
    setNotice(null);
    const stage = setBg(d);
    showGame();
    resetGame();
    // What this match's record is filed under. A reconnect re-admits into the
    // match already in progress, so a context that is set is kept and only
    // filled in from what the frame adds -- a snapshot names the opponent but
    // not the length -- while the rounds already filed for it go with it. A
    // match this client was not in starts a record of its own.
    if (!matchCtx) pendingRounds = [];
    const seen = matchCtx || {};
    matchCtx = {
      opponentName: d.opponentName || seen.opponentName || null,
      opponentCharacter: d.opponentCharacter || seen.opponentCharacter || null,
      roundsTarget: Number(d.roundsTarget) || seen.roundsTarget || 0,
      background: stage,
    };
    // The target arrives with the match, not with its first result, so the pips
    // go up empty and are there for every round of the series instead of
    // appearing partway into it. Whatever the previous match left on screen goes
    // with it. A `matched` without a target -- PvP, or a server predating the
    // field -- draws nothing, which is the same "no series" reading as a result
    // without one.
    renderPips(0, 0, d.roundsTarget, d.drawEnds);
    setYouSlot();
    setOppSlot(d.opponentCharacter || null, d.opponentName || 'Opponent');
    // Which floor this is, said once at the match rather than in a permanent
    // label: the opponent slot already carries the fighter, and the countdown
    // takes this element for its own beats.
    setCount(ladderFloor >= 0 ? `FLOOR ${ladderFloor + 1}` : 'MATCH FOUND');
    armReadyLoop();
  },

  countdown(d, from) {
    // No clearTimeout(stallTimer) here: `countdown` is a live game state
    // (GAME_STATES), and a snapshot can route an armed round back into it, so
    // disarming on entry would drop the watchdog exactly when the round it was
    // armed for is still running. The non-game entries are where it disarms.
    if (from === 'matched') {
      stopReadyLoop();
      showGame();
    } else if (from === 'result') {
      // The gate this round waited on has passed; stop asking.
      stopReadyLoop();
      // Round two of a series. The match screen, background and opponent slot
      // were established by round one and a countdown frame carries neither, so
      // the rejoin branch below would wipe the opponent back to a generic
      // "Opponent" -- losing the CPU's name and the character both players chose
      // for a reason neither could see. resetGame still runs: it is what clears
      // the previous round's result panel and hides its rematch buttons, which
      // would otherwise sit on screen through the next round.
      showGame();
      resetGame();
      // ...and the pips the round just moved go back up: they belong to the
      // series, not to the round panel resetGame just cleared.
      paintPips();
    } else if (!GAME_STATES.includes(from)) {
      setBg(d);
      showGame();
      resetGame();
      setYouSlot();
      setOppSlot(d.opponentCharacter || null, d.opponentName || 'Opponent');
    } else {
      showGame();
      if (d.opponentCharacter) {
        setOppSlot(d.opponentCharacter, d.opponentName);
      }
    }
    // With shootAt announced, planFromCountdown owns the count paint and shows
    // the slot that is genuinely due; without it, fall back to the frame's n.
    if (d.shootAt) planFromCountdown(d);
    else setCount(d.n ?? 'Get ready');
    $('#stage').classList.remove('go');
  },

  shoot(d, from) {
    stopReadyLoop();
    const plan = KXP.shootWindow(Date.now(), d.shootAt, d.windowMs, remainingWindowMs, clockSkew);
    armStallWatchdog();
    if (!GAME_STATES.includes(from)) {
      setBg(d);
      showGame();
      resetGame();
      setYouSlot();
      setOppSlot(null, 'Opponent');
    } else {
      showGame();
    }
    clearTimeout(shootTimer);
    if (plan.actionable) {
      sawPunAt = Date.now();
      remainingWindowMs = plan.remainingMs;
      setCount('PUN!');
      $('#stage').classList.add('go');
      enableMoves();
      shootTimer = setTimeout(() => transition('lock'), plan.remainingMs);
    } else {
      // The window is already past (delivery lag or client clock skew); show
      // no doomed PUN, just wait for the authoritative result.
      setCount('Waiting for result\u2026');
      shootTimer = setTimeout(() => transition('lock'), 50);
    }
  },

  locked(d) {
    lockMoves();
    if (d.move) flashPick(d.move);
    if (d.error) {
      setCount(KXP.rejectLabel(d.error));
      $('#stage').classList.add('go');
    }
  },

  result(d) {
    stopReadyLoop();
    clearTimeout(shootTimer);
    clearTimeout(stallTimer);
    lockMoves();
    lastMode = d.mode || 'online';
    lastTarget = Number(d.roundsTarget) || 0;
    // The rule rides in for the rematch the way the length does: at a target of
    // one it is the whole difference between 1-off and first-to-1, so "the same
    // match again" means repeating both halves.
    lastDrawEnds = d.drawEnds;
    const s = KXP.applyResult(getStats(), d.outcome);
    saveStats(s);
    setStats();
    // Ladder progress moves on the match's final result and nothing else. A
    // mid-series round is not a decided floor: advancing on one would hand out a
    // floor for a round, and restarting on one would drop the player down the
    // ladder mid-series. `seriesOver !== false` is the same "older server reads
    // every result as final" rule the Play Again button uses, so an open tab
    // across a deploy still progresses once.
    const wasFloor = ladderFloor;
    if (wasFloor >= 0 && d.seriesOver !== false) ladderNext = advanceLadder(d.outcome);
    else if (wasFloor >= 0) ladderNext = null;
    // The record this browser keeps, on the same rule the ladder just used: every
    // round is filed as it resolves, and the match itself on the frame that
    // decides it -- a mid-series round is a row of a match still to be decided,
    // and this is where that match gets decided or not at all.
    recordRound(d);
    if (d.seriesOver !== false) commitMatch(d);
    renderResult(d);
    // The between-rounds gate. An online series pauses after every non-final
    // round with the same readiness handshake open again, and the next
    // countdown cannot arrive until this client acks it -- the player is
    // looking at the result panel, so this arm is the only one that will run.
    // A bot's series never opens that gate (its side is this screen), so a CPU
    // result arms nothing rather than posting into 409s all through the pause.
    if (d.seriesOver === false && d.mode === 'online') armReadyLoop();
  },

  // The tower, between arcade floors. Reached from the result screen when the
  // player asks for what comes next -- the climb happens on a screen they are
  // looking at rather than over a result they are still reading -- and from the
  // picker's start button, so the mode's first screen is the run itself.
  ladder() {
    stopReadyLoop();
    clearTimeout(stallTimer);
    // A roster that emptied between the match and this frame -- a deploy, a
    // roster written down to nothing -- leaves no floors to draw and no fighter
    // to send out. The lobby is where the mode lives either way.
    const a = readArcade(ladderPair);
    if (!a.order.length) { transition('mode'); return; }
    // Save the run before it is shown. A first run's order is drawn by
    // readArcade -- only after the picker, because the draw depends on the fighter
    // picked there -- and a match is otherwise the first thing to make it durable.
    // That is safe from the result screen, where the fight just saved the order,
    // but not from the lobby: showing a draw storage has never heard of would let
    // the Fight button draw a different ladder under the player.
    saveArcade(ladderPair, a);
    showTower();
  },

  // The record, read when it is asked for rather than kept in step with it: it
  // is this browser's own, and rendering on entry is what makes a match
  // committed a moment ago -- or by another tab -- visible without a reload.
  // Reached from the lobby and left by the same `mode` edge the tower's leave
  // button takes, so leaving runs the lobby's entry rather than swapping views
  // behind its back.
  history() {
    renderHistory();
    show('history');
  },
};

// The persistent player id is the server's to mint, so the client only reads
// and stores it. Storage can throw (private mode, disabled), in which case the
// client simply reconnects as a fresh player.
function loadPid() {
  try { return localStorage.getItem('kxp-pid'); } catch (e) { return null; }
}

function savePid(p) {
  try { localStorage.setItem('kxp-pid', p); } catch (e) {}
}

function connect() {
  const params = new URLSearchParams();
  if (id) params.set('id', id);
  if (pid) params.set('pid', pid);
  const query = params.toString();
  es = new EventSource(query ? `/events?${query}` : '/events');

  es.addEventListener('connected', (e) => {
    const d = JSON.parse(e.data);
    // The server mints the pid on a first visit and echoes it thereafter; store
    // it so a reload or a second tab presents the same player.
    if (d.pid && d.pid !== pid) {
      pid = d.pid;
      savePid(pid);
    }
    if (d.id !== id) {
      es.close();
      id = d.id;
      connect();
      return;
    }
    id = d.id;
    setOnline(d.online);
    if (d.now) clockSkew = d.now - Date.now();
    post('/character', { character: loadCharacter() });
    try {
      const params = new URLSearchParams(location.search);
      const token = params.get('challenge');
      if (token && d.state === 'idle') {
        // The claim runs at most once per page load. `connected` is an SSE
        // reconnect event, not a once-per-load one, and a second claim would
        // post into a token the first already consumed. The latch is only set
        // on an actual attempt and is never reset: a non-idle snapshot is the
        // match the claim just built, and clearing it there would let the
        // reconnect after that match re-claim its own consumed token.
        if (!window.__challengeJoined) {
          window.__challengeJoined = true;
          post('/join', { id, token }).then((res) => {
            if (!res.ok) {
              try { history.replaceState({}, '', location.pathname); } catch (e) {}
              setNotice('Challenge expired or already in play');
            }
          });
        }
      }
    } catch (e) {}

    // A challenge waiter that reconnects -- or reloads -- arrives on a waiting
    // snapshot carrying the link's token. The creator's own URL has no token the
    // way a claimant's does, so this is the only thing that can rebuild the
    // screen; without it the wait would drop to the lobby and the link with it.
    // Rebuild it before the transition below, which is what shows the link.
    if (d.challenge) {
      showInvite(d.challenge);
    }

    if (d.state === 'waiting') transition('snapshot:waiting', d);
    else if (d.state === 'ingame') {
      if ((d.phase === 'preparing' || d.phase === 'countdown' || d.phase === 'done') && d.pending) {
        // Mid-handshake: the server is still holding the readiness gate open and
        // has told us to re-admit, so come back as `matched`, which re-arms the
        // ack. `preparing` is the server's name for this span; `countdown` is
        // still accepted because a server predating the phase split reports the
        // same state under the old name. `done` with `pending` is the
        // between-rounds pause of an online series: the round is over, the
        // match is not, and the gate is what the client must ack to continue.
        transition('snapshot:matched', d);
      } else if (d.phase === 'done') {
        // Match already finished; there is no result to catch up on.
        transition('snapshot:idle', d);
      } else if (d.phase === 'shoot' && d.shootAt && d.windowMs && Date.now() + clockSkew - d.shootAt >= d.windowMs) {
        // PUN window already closed; nothing playable to rejoin.
        report('rejoin-past-window', 'shoot');
        transition('snapshot:idle', d);
      }
      else transition(d.phase === 'shoot' ? 'snapshot:shoot' : 'snapshot:countdown', d);
    }
    else transition('snapshot:idle', d);
  });

  es.addEventListener('online', (e) => {
    setOnline(JSON.parse(e.data).count);
  });

  es.addEventListener('waiting', (e) => {
    transition('waiting', JSON.parse(e.data));
  });

  es.addEventListener('matched', (e) => {
    transition('matched', JSON.parse(e.data));
  });

  es.addEventListener('countdown', (e) => {
    transition('countdown', JSON.parse(e.data));
  });

  es.addEventListener('shoot', (e) => {
    transition('shoot', JSON.parse(e.data));
  });

  es.addEventListener('result', (e) => {
    transition('result', JSON.parse(e.data));
  });

  es.addEventListener('opponent-left', (e) => {
    const d = JSON.parse(e.data);
    // The note is a claim about the recipient. The between-rounds timeout sends
    // this frame to the side that never answered as well, and "you win" drawn
    // over an outcome of loss would contradict the frame it comes from. The
    // distinct event matters too: from the result screen this is a re-decision
    // of the series, not a duplicate round result, which is the edge
    // `result`+`opponentLeft` exists for.
    transition('opponentLeft', d.outcome === 'loss' ? d : { ...d, note: 'Opponent left \u2014 you win!' });
  });

  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    const s = d.state;
    if (s === 'idle') {
      // After a finished match the result screen is terminal until the player
      // acts (Play Again / Change mode), so the server's trailing `state idle`
      // teardown frame is expected, not an anomaly — never a bad-transition.
      // The tower is the same case one step later: it is only reachable from a
      // decided ladder match, so the frame that arrives after it has been routed
      // to is the *previous* match's teardown. Routing it to the lobby would walk
      // the player off the ladder they were about to climb.
      if (state === 'result' || state === 'ladder') return;
      // The record is the lobby's own screen: nothing of a match is live behind
      // it, so this teardown has nothing to reconcile, and routing it to the
      // lobby would walk the player out of the record they opened. The one
      // exception is a `requeued` frame, which is the server saying the queue is
      // live -- its view has to win over the screen it interrupts.
      if (state === 'history' && !d.requeued) return;
      // A cancelled handshake arrives here too, carrying the server's reason.
      // `requeued` means the server put us back on the online queue, so going
      // to the lobby would be a lie: the player would sit in a lobby that looks
      // idle while the server held them in the queue, with no Searching view and
      // no Cancel. Step to `waiting` instead, so the queue UI is real again.
      transition(d.requeued ? 'waiting' : 'stateIdle', d);
    } else transition('snapshot:waiting', d);
  });

  es.onerror = () => {
    // The spec fires this on every auto-reconnect attempt too, so a normal
    // blip reports here once per beaconGate window. Connection loss is exactly
    // what the diagnostics slice wants to see from the client side.
    report('sse-error', state);
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadRoster();
  connect();
  setStats();
  renderFighters();

  $('#fighters').addEventListener('click', (e) => {
    const b = e.target.closest('.fighter');
    if (!b) return;
    const cid = b.dataset.char;
    saveCharacter(cid);
    renderFighters();
    post('/character', { character: cid });
  });

  $('#btn-online').addEventListener('click', () => openChoose('online'));
  $('#btn-cpu').addEventListener('click', () => openChoose('cpu'));
  $('#btn-ladder').addEventListener('click', () => openChoose('ladder'));
  $('#btn-start').addEventListener('click', () => {
    const btn = $('#btn-start');
    if (btn.disabled) return;
    const mode = pendingMode;
    pendingMode = '';
    armPending(btn);
    if (mode === 'online') {
      // Invite-first: the confirm reserves the player at the lobby's chosen
      // length and hands them a code, rather than entering the matchmaker. A
      // refusal restores the mode the button was pressed for, so the same tap
      // retries the same request.
      mintChallenge({ roundsTarget: cpuTarget, drawEnds: cpuDrawEnds }, 'queue', (res) => {
        pendingMode = mode;
        if (res && res.status === 409) setNotice('You are already in a match.');
      });
      return;
    }
    if (mode === 'ladder') {
      ladderPair = currentPair();
      if (!transition('climb')) {
        clearPending();
        pendingMode = mode;
      }
      return;
    }
    postPending(btn, postCPU(mode), (res) => {
      pendingMode = mode;
      if (res && res.status === 409) setNotice('You are already in a match.');
    });
  });
  // The length and draw rule a CPU match runs as. The numbers are the control's
  // own, so the client posts a choice it was shown rather than a copy of the
  // rules; the server decides whether it is a length it offers. The rule rides
  // because at a target of one it is the whole difference between 1-off and
  // first-to-1 -- two buttons sharing a number, told apart only by what a draw
  // does. No option is marked selected in the markup: the choice is made here,
  // once the roster that frames the lobby has arrived, because an option painted
  // in markup would flash in the first paint and then swap to whatever the
  // player saved.
  const lengthBtns = document.querySelectorAll('#cpu-length .seg-btn');
  lengthBtns.forEach((b) => {
    b.addEventListener('click', () => {
      lengthBtns.forEach((o) => {
        o.classList.toggle('selected', o === b);
      });
      cpuTarget = Number(b.dataset.rounds) || 0;
      // The rule is read off the attribute the button carries, so a mode added
      // to the markup without one is a mode with a rule of its own, never an
      // accidental borrow of another button's.
      cpuDrawEnds = b.dataset.drawEnds === 'true';
      // Each pair owns its own run now, so switching the selection only changes
      // which one the entry reads -- the one just left is kept, not discarded.
      // Re-label because the pair's run may be cleared where the other was not.
      setLadderEntry();
      try {
        localStorage.setItem(CPU_LENGTH_KEY, String(cpuTarget));
        localStorage.setItem(CPU_DRAWENDS_KEY, String(cpuDrawEnds));
      } catch (e) {}
    });
  });
  // The default is the control's first option (today "1 round"), decided here
  // rather than claimed by the markup. A saved choice overrides it when the
  // control still offers that one; storage that refuses a write must not stop
  // the match from starting, and a store edited by hand falls back rather than
  // posting a length no button carries.
  const firstLength = lengthBtns[0];
  if (firstLength) {
    firstLength.classList.add('selected');
    cpuTarget = Number(firstLength.dataset.rounds) || 0;
    cpuDrawEnds = firstLength.dataset.drawEnds === 'true';
  }
  // The saved (length, rule) pair. A store without the rule key predates the
  // split and matches on length alone, keeping the old meaning a stored length
  // has always had; one with it matches on both, so a saved length must not
  // silently change mode. Two buttons can share a length, so the first match
  // wins -- the control lists each length's original mode first, which is what a
  // pre-rule store means. A pair no button offers falls back like any other
  // stray value.
  const savedTarget = Number(localStorage.getItem(CPU_LENGTH_KEY));
  const savedEnds = localStorage.getItem(CPU_DRAWENDS_KEY);
  if (savedTarget) {
    let restored = null;
    lengthBtns.forEach((b) => {
      if (restored) return;
      if (Number(b.dataset.rounds) !== savedTarget) return;
      if (savedEnds === null || b.dataset.drawEnds === savedEnds) restored = b;
    });
    if (restored) {
      lengthBtns.forEach((o) => {
        o.classList.toggle('selected', o === restored);
      });
      cpuTarget = savedTarget;
      cpuDrawEnds = restored.dataset.drawEnds === 'true';
    }
  }
  // After the selection is restored, not before: the entry reads the run for the
  // pair the restore settled on, so a reload shows the right label for the mode
  // the player actually left on.
  setLadderEntry();

  $('#btn-back').addEventListener('click', () => show('lobby'));
  $('#btn-cancel').addEventListener('click', () => {
    transition('cancel');
    post('/cancel');
  });
  // Send the invite through the browser's share sheet when there is one -- on a
  // phone that is the way a link is meant to travel -- and fall back to Copy
  // wherever it is absent, refuses (an insecure context), or is dismissed (the
  // user cancelled, which rejects). The promise is handled here rather than left
  // to float: an unhandled rejection from a cancelled sheet would reach the
  // error beacon and read as a client fault.
  $('#btn-share').addEventListener('click', () => {
    const inp = document.getElementById('challenge-url');
    const url = inp && inp.value;
    if (!url) return;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        const p = navigator.share({ title: 'KACHIPUN TOURNAMENT', text: 'Fight me!', url });
        if (p && p.catch) p.catch(() => copyInvite());
        return;
      } catch (e) {}
    }
    copyInvite();
  });
  $('#btn-copy').addEventListener('click', copyInvite);
  // No share sheet, no Share button: on a desktop the control would do exactly
  // what the Copy beside it does, so the fallback is the whole of it.
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    const shareBtn = $('#btn-share');
    if (shareBtn && shareBtn.classList) shareBtn.classList.add('hidden');
  }
  // The claim half of the invite screen: the player pasted someone else's code
  // and is joining their reservation. Success is the `matched` frame, not the
  // reply, so nothing moves the screen here; a refusal shows inline and leaves
  // the screen -- and the player's own code, if they hold one -- intact.
  $('#btn-claim').addEventListener('click', () => {
    const inp = document.getElementById('claim-url');
    const token = tokenFromPaste(inp && inp.value);
    if (!token) {
      setClaimError('Paste a link or code first.');
      return;
    }
    setClaimError('');
    post('/join', { token }).then((res) => {
      if (res && res.ok) return;
      if (res && res.status === 404) setClaimError('That code has expired or was already used.');
      else if (res && res.status === 409) setClaimError('That game is already in play.');
      else setClaimError('Could not join \u2014 check the code and try again.');
    });
  });
  // The fallback: leave the reservation and take the ordinary matchmaker wait.
  // The cancel must land first, or the queue join trips the server's "challenge
  // already open" guard and the player is stuck on a code they no longer want.
  $('#btn-search').addEventListener('click', () => {
    challengePending = false;
    renderInvite();
    post('/cancel').then(() =>
      post('/queue', { roundsTarget: cpuTarget, drawEnds: cpuDrawEnds })
    );
  });


  // The record, from the lobby that holds it. The back button is the tower's
  // leave button one screen over: `mode` puts the lobby back the way it was,
  // which is what a player who opened a list expects to return to.
  $('#btn-history').addEventListener('click', () => transition('history'));
  $('#btn-history-back').addEventListener('click', () => transition('mode'));

  $('#btn-again').addEventListener('click', () => {
    if (ladderNext) {
      // The ladder's own action, ahead of the CPU branch below: both are CPU
      // matches, and a plain rematch must never be able to stand in for the next
      // floor -- that would ask for floor one again and read as a ladder that had
      // reset itself.
      //
      // It goes to the tower rather than straight into the fight, because the next
      // floor is a different fighter and the tower is where that gets said and
      // animated. Disarmed for the same double-tap reason as the branches below,
      // and re-armed if the route is refused -- and it is the result screen's
      // button, not the tower's, which showTower arms.
      const btn = $('#btn-again');
      armPending(btn);
      if (!transition('climb')) clearPending();
      return;
    }
    // The match that just ended, not the lobby's current selection: "Play
    // Again" means the same match again. The rule comes back with the length
    // because first-to-1 and 1-off share a target; if the result reported
    // nothing it falls back to the selection, with the same "older server"
    // reading as the length's fallback -- and at a target of one that reading
    // is 1-off, the mode an absent rule has always meant.
    const again = lastTarget || cpuTarget;
    const againEnds = lastDrawEnds ?? (again <= 1);
    if (lastMode === 'cpu') {
      postPending($('#btn-again'), post('/cpu', { roundsTarget: again, drawEnds: againEnds }));
    } else {
      // Invite-first rematch: the ended match's reservation is spent, so a fresh
      // one is minted and the invite screen returns with a new code. The length
      // is the match that just ran, not the lobby's current selection.
      armPending($('#btn-again'));
      mintChallenge({ roundsTarget: again, drawEnds: againEnds }, 'rematch:online');
    }
  });
  $('#btn-mode').addEventListener('click', () => {
    transition('mode');
  });

  // The tower's own fight button: the same request the result screen's would have
  // made -- the floor the run is on, at the run's own length -- from the screen
  // the player is looking at now. The re-arm on failure is the guard the other two
  // entry points carry, because a rejected tap must not be a dead button.
  $('#ladder-fight').addEventListener('click', () => {
    const btn = $('#ladder-fight');
    if (btn.disabled) return;
    postPending(btn, postCPU('ladder'));
  });
  // Leaving mid-run. The tower draws the whole run, so without this the one
  // screen that shows all of it would be the one a player could not back out of.
  $('#ladder-leave').addEventListener('click', () => transition('mode'));

  document.querySelectorAll('.move').forEach((b) => {
    b.addEventListener('click', () => {
      const move = b.dataset.move;
      if (!transition('move', { move })) return;
      post('/move', { move, clickedAt: Date.now(), sawPunAt }).then((res) => {
        if (res && !res.ok) transition('reject', { error: res.error });
      });
    });
  });
});