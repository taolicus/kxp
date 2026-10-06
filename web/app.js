const KXP = window.KXP;
const SM = window.StateMachine;

let id = null;
let state = 'lobby'; // lobby | waiting | countdown | shoot | locked | result
let lastMode = 'online'; // online | cpu — mode of the finished match
// The CPU series length the lobby has selected, and the one the finished match
// actually played. Nothing here is a literal copy of the rules: the selection is
// read from the control that offers it -- or, when the player has a saved choice
// the control still offers (see the wiring below), from storage -- and a rematch
// repeats what the player just played rather than what the lobby happens to show
// now.
let cpuTarget = 0;
let lastTarget = 0;
// The floor of the ladder match in progress, and -1 when the match is not a
// ladder match. The mode on the wire is `cpu` for both, so the distinction has to
// live here; the server has no ladder to know about.
let ladderFloor = -1;
// What the result screen offers a ladder match: 'next', 'retry', 'done', or null
// when the match that ended was not a ladder match.
let ladderNext = null;
let pendingMode = null; // online | cpu — mode picked on the lobby, awaiting fighter confirmation
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
    if (state !== 'shoot' && state !== 'countdown') return;
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
  bgReady = applyBg(bgNameFor(d));
  return bgReady;
}

// showGame defers showing the game view until the current bg is loaded. Guarded
// so a late load never paints the game screen after the player already left.
function showGame() {
  bgReady.then(() => {
    if (state !== 'lobby' && state !== 'waiting') show('game');
  });
}

const $ = (sel) => document.querySelector(sel);

let readyTimer = null;

function stopReadyLoop() {
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
// The gate is a buffer, not a guarantee, and the cost is a lost round: if the
// link is too slow to deliver an ack within the server's 8s, it cancels the
// pending match and sends `state idle`, which drops us back to the lobby with the
// reason shown.
function armReadyLoop() {
  if (state !== 'matched') return;
  // Behind bgReady, so the frame we wait for is a frame of the match screen
  // rather than of whatever was on screen while the background downloaded.
  // setBg() runs before this in every handler that reaches it, so bgReady is
  // already this match's promise by the time we chain onto it.
  bgReady.then(() => {
    // The match can end while the background is still loading; arming then would
    // ack a match that no longer exists.
    if (state !== 'matched') return;
    const go = () => {
      if (state !== 'matched' || document.visibilityState === 'hidden') return;
      sendReady();
      stopReadyLoop();
      readyTimer = setInterval(() => {
        if (state !== 'matched') { stopReadyLoop(); return; }
        sendReady();
      }, 2000);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    else go();
  });
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== view);
  });
  document.body.classList.toggle('in-game', view === 'game');
  if (view !== 'game') lockMoves();
}

function setCount(t) { $('#count').textContent = t; }

function setOnline(n) {
  const el = $('#online');
  const btn = $('#btn-online');
  if (n == null) { el.innerHTML = '&hellip;'; return; }
  el.innerHTML = `<span class="dot${n === 0 ? ' dim' : ''}"></span>${n} online now`;
  btn.disabled = n === 0;
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
const ARCADE_KEY = 'kxp-arcade';

// Where the lobby remembers its chosen CPU series length, so a reload is not a
// change of heart. It holds the number, not a button: a control that no longer
// offers the stored length must fall back rather than post one nothing on screen
// matches (see the wiring below).
const CPU_LENGTH_KEY = 'kxp-cpu-length';

// readArcade returns the saved run, repaired against the current roster. A run
// with no saved order is a first run, and draws one -- deliberately not at
// startup, because the draw depends on which fighter the player has picked, and
// they pick it after the lobby is on screen.
function readArcade() {
  // Whatever is in storage is untrusted: it is writable by hand and outlives the
  // code that wrote it. "null" and a bare number parse, so the shape is checked
  // rather than assumed -- anything that is not an object is a first run.
  let s = null;
  try { s = JSON.parse(localStorage.getItem(ARCADE_KEY) || '{}'); } catch (e) { s = null; }
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
  // a ladder they have not climbed. The high-water mark survives, because it is a
  // count of floors cleared and means the same thing across any two orders.
  const floor = fresh ? 0
    : Math.min(Math.max(Number(s.floor) || 0, 0), order.length - 1);
  // Cleared is a fact about the run -- the mirror is down -- not a position in the
  // order, so it survives a repair and does not survive a redraw.
  return {
    order,
    floor,
    best: Math.max(Number(s.best) || 0, 0),
    cleared: !fresh && !!s.cleared,
  };
}

function saveArcade(a) {
  try { localStorage.setItem(ARCADE_KEY, JSON.stringify(a)); } catch (e) {}
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

// advanceLadder moves the run on after a ladder match has been decided and says
// which floor is next. A win climbs one floor; a loss puts the player back on
// the first, as in the arcade original. A drawn floor is neither: the floor's
// request always says its drawers replay (drawEnds: false), so a draw against an
// honouring server replays and never reaches a result here -- the branch exists
// as the client-side half of the same rule, that an outcome which cannot decide a
// floor must not be able to reset one. It reads and writes the run with the same
// repair on the way in, so a ladder that crossed a deploy which changed the
// roster progresses on the repaired order rather than on one that is no longer
// valid.
//
// Returns what the result screen should offer, since the honest label differs:
// the next floor after a win, the first again after a loss, the same floor again
// after a draw, and a new ladder once the mirror is down. 'done' is not a stage
// of the run -- the cleared run stays where it is, so the high-water mark and
// the next request are both still readable -- but it is what the button says.
function advanceLadder(outcome) {
  const a = readArcade();
  // Counted from the run's own floor, not from the floor the request was made on:
  // the two agree in the normal sequence, and the run cannot disagree with itself.
  // The request-time copy goes stale if a match is ever reached without going
  // through postCPU, and it is the run that the high-water mark has to agree with.
  // Only a win clears a floor -- counting a lost floor here would report a run that
  // got further the more it lost, which is the opposite of a high-water mark.
  if (outcome === 'win') a.best = Math.max(a.best, a.floor + 1);
  if (outcome === 'win') {
    if (a.floor >= a.order.length - 1) {
      // The mirror is down. The run stays where it is and says it is cleared,
      // rather than the floor wrapping to zero and the ladder reading as a run in
      // progress that has already been beaten -- which is what the lobby would
      // otherwise invite the player to resume.
      a.cleared = true;
      a.floor = 0;
      saveArcade(a);
      return 'done';
    }
    a.floor += 1;
  } else if (outcome === 'loss') {
    a.floor = 0;
  } else {
    a.cleared = false;
    saveArcade(a);
    return 'retry-floor';
  }
  a.cleared = false;
  saveArcade(a);
  return outcome === 'win' ? 'next' : 'retry';
}


// The lobby's ladder line: which floor the player would resume on, who is
// standing on it, and how far the run has ever got. Read-only -- resuming is a
// stored order, not a flag, so this never draws.
function setLadderInfo() {
  const el = $('#ladder-info');
  if (!el) return;
  const a = readArcade();
  const btn = $('#btn-ladder');
  if (btn) {
    btn.disabled = !CHARACTERS.length;
    // A cleared ladder has nothing to resume, so the entry says it will draw a new
    // one. Leaving the label alone would have the player pick a fighter and be told
    // there is nothing to fight.
    btn.textContent = a.cleared ? 'New Arcade Mode' : 'Arcade Mode';
  }
  // Hidden rather than empty: an empty paragraph still carries its margin, which
  // would be a gap above the buttons for the moment before the roster arrives.
  if (!CHARACTERS.length) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const c = a.cleared ? null : characterByID(a.order[a.floor]);
  const at = a.cleared ? 'Arcade complete'
    : `Floor ${a.floor + 1} of ${a.order.length}${c ? ` \u00b7 ${c.name}` : ''}`;
  el.textContent = a.best > 0 ? `Arcade Mode \u00b7 ${at} \u00b7 Best ${a.best}` : `Arcade Mode \u00b7 ${at}`;
}

// The tower: the run drawn as the ladder it is. One row per floor, in the order
// the floors are fought, with the player standing on the floor the run is on --
// right beside the fighter they are about to meet, or the one they just beat.
//
// Two things are decided here rather than left to the CSS. Where the player
// stands: a cleared run stands at the top, because its floor was reset to zero so
// the lobby would not offer a beaten ladder as a run in progress, and the tower is
// the one place that is not true. And which way the climb went, from the floor
// just fought to the floor the run moved to -- `ladderFloor` is the only record of
// where the player came from, since the run stores where they are.
//
// The rows are the whole order rather than a window onto it, and the markup is in
// match order with CSS laying it out bottom-up: a ladder that showed only the next
// few floors would be a list, and seeing how far is left is the point of climbing.
function showTower() {
  const a = readArcade();
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
  $('#btn-start').textContent = mode === 'online' ? 'Search for Opponent' : 'Fight!';
  $('#btn-start').disabled = false;
  if (CHARACTERS.length && !localStorage.getItem('kxp-character')) {
    saveCharacter(CHARACTERS[0].id);
  }
  renderFighters();
  show('choose');
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
        : ladderNext === 'retry-floor' ? 'Retry This Floor' : 'Next Floor';
    }
    $('#btn-mode').classList.remove('hidden');
  }
  renderPips(d.youRoundWins, d.oppRoundWins, d.roundsTarget);
  setYouSlot();
  setOppSlot(d.opponentCharacter, d.opponentName);
}

// The series scoreboard: one pip per round win a side still needs, filled as it
// takes them. Driven by the server's roundsTarget rather than a count written
// here, so the row is exactly as long as the series is and the client holds no
// copy of the rules.
//
// Only for a series that takes more than one round. A match one round long has
// no running tally to show -- it is over before the pips could fill more than
// once -- and a single pip would say nothing the result banner does not already
// say. So the cutoff is at two, not at one: a scoreboard is for something that
// goes on.
function renderPips(you, opp, target) {
  seriesTally = target > 1 ? { you, opp, target } : null;
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
function postCPU(mode, { roundsTarget = cpuTarget } = {}) {
  if (mode !== 'ladder') {
    ladderFloor = -1;
    return post('/cpu', { roundsTarget });
  }
  // A cleared run -- or a stored position past the end of the order, which the
  // clamp cannot produce but a hand-edited store can -- starts a new ladder. This is
  // the only redraw, so both the result screen's "New Arcade Mode" and the lobby's entry
  // go through it, and neither can leave a player with nothing to do.
  const a = readArcade();
  if (a.cleared || a.floor >= a.order.length) {
    a.order = drawOrder();
    a.floor = 0;
    a.cleared = false;
  }
  ladderFloor = a.floor;
  saveArcade(a);
  // A floor is never 1-off: drawn rounds replay, so a draw can never decide a
  // floor. The server defaults a one-round request to "end on a draw", which is
  // exactly what a 1-off CPU match wants, so the ladder has to say otherwise.
  return post('/cpu', { roundsTarget, opponentCharacter: a.order[a.floor], drawEnds: false });
}

async function post(path, body = {}) {
  if (!id) return null;
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    });
    let error = '';
    try { error = (await resp.json()).error || ''; } catch (e) {}
    return { ok: resp.ok, status: resp.status, error };
  } catch (e) {
    report('fetch-error', state);
    return null;
  }
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
    setLadderInfo();
    // The match is over -- finished, cancelled or abandoned -- so the series it
    // belonged to is too, and the next one starts from empty pips.
    seriesTally = null;
    paintPips();
    show('lobby');
    setNotice(d && d.reason);
  },

  waiting(d) {
    stopReadyLoop();
    clearTimeout(stallTimer);
    show('queue');
    // A plain /queue has no reason, so this clears any notice left over from an
    // earlier cancelled handshake rather than stranding it above the spinner.
    setNotice(d && d.reason);
  },

  matched(d) {
    stopReadyLoop();
    clearTimeout(stallTimer);
    setNotice(null);
    setBg(d);
    showGame();
    resetGame();
    // The target arrives with the match, not with its first result, so the pips
    // go up empty and are there for every round of the series instead of
    // appearing partway into it. Whatever the previous match left on screen goes
    // with it. A `matched` without a target -- PvP, or a server predating the
    // field -- draws nothing, which is the same "no series" reading as a result
    // without one.
    renderPips(0, 0, d.roundsTarget);
    setYouSlot();
    setOppSlot(d.opponentCharacter || null, d.opponentName || 'Opponent');
    // Which floor this is, said once at the match rather than in a permanent
    // label: the opponent slot already carries the fighter, and the countdown
    // takes this element for its own beats.
    setCount(ladderFloor >= 0 ? `FLOOR ${ladderFloor + 1}` : 'MATCH FOUND');
    armReadyLoop();
  },

  countdown(d, from) {
    clearTimeout(stallTimer);
    if (from === 'matched') {
      stopReadyLoop();
      showGame();
    } else if (from === 'result') {
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
    renderResult(d);
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
    const a = readArcade();
    if (!a.order.length) { transition('mode'); return; }
    // Save the run before it is shown. A first run's order is drawn by
    // readArcade -- only after the picker, because the draw depends on the fighter
    // picked there -- and a match is otherwise the first thing to make it durable.
    // That is safe from the result screen, where the fight just saved the order,
    // but not from the lobby: showing a draw storage has never heard of would let
    // the Fight button draw a different ladder under the player.
    saveArcade(a);
    showTower();
  },
};

function connect() {
  es = new EventSource(id ? `/events?id=${encodeURIComponent(id)}` : '/events');

  es.addEventListener('connected', (e) => {
    const d = JSON.parse(e.data);
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
    if (d.state === 'waiting') transition('snapshot:waiting', d);
    else if (d.state === 'ingame') {
      if (d.phase === 'done') {
        // Match already finished; there is no result to catch up on.
        transition('snapshot:idle', d);
      } else if ((d.phase === 'preparing' || d.phase === 'countdown') && d.pending) {
        // Mid-handshake: the server is still holding the readiness gate open and
        // has told us to re-admit, so come back as `matched`, which re-arms the
        // ack. `preparing` is the server's name for this span; `countdown` is
        // still accepted because a server predating the phase split reports the
        // same state under the old name.
        transition('snapshot:matched', d);
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
    transition('result', { ...JSON.parse(e.data), note: 'Opponent left \u2014 you win!' });
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
  setLadderInfo();
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
    // Re-entry guard, mirroring #btn-again. Without it a double-tap fires two
    // /cpu posts in one tick; the server now rejects the second with 409, but
    // the guard is what keeps a tap-tap on a phone from asking for a match the
    // player already has. Re-armed on failure so a rejected tap is not a dead
    // button, and pendingMode is consumed so a later failure cannot restore a
    // mode the player has already left.
    const btn = $('#btn-start');
    if (btn.disabled) return;
    const mode = pendingMode;
    pendingMode = '';
    btn.disabled = true;
    if (mode === 'online') transition('queue');
    if (mode === 'ladder') {
      // The mode's first screen is the tower: the run it would resume is already
      // rendered there, and its Fight button starts the floor. No request is made
      // from the picker, so nothing is re-armed on success -- the view is left
      // behind -- but a refused route must not deaden the button.
      if (!transition('climb')) {
        btn.disabled = false;
        pendingMode = mode;
      }
      return;
    }
    const p = mode === 'online' ? post('/queue') : postCPU(mode);
    Promise.resolve(p).then((res) => {
      if (res && res.ok) return;
      btn.disabled = false;
      pendingMode = mode;
      if (res && res.status === 409) setNotice('You are already in a match.');
    });
  });
  // The length a CPU match runs for. The numbers are the control's own, so the
  // client posts a choice it was shown rather than a copy of the rules; the
  // server decides whether it is a length it offers. No option is marked
  // selected in the markup: the choice is made here, once the roster that
  // frames the lobby has arrived, because an option painted in markup would
  // flash in the first paint and then swap to whatever the player saved.
  const lengthBtns = document.querySelectorAll('#cpu-length .seg-btn');
  lengthBtns.forEach((b) => {
    b.addEventListener('click', () => {
      lengthBtns.forEach((o) => {
        o.classList.toggle('selected', o === b);
      });
      cpuTarget = Number(b.dataset.rounds) || 0;
      try { localStorage.setItem(CPU_LENGTH_KEY, String(cpuTarget)); } catch (e) {}
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
  }
  const savedTarget = Number(localStorage.getItem(CPU_LENGTH_KEY));
  if (savedTarget) {
    let restored = null;
    lengthBtns.forEach((b) => {
      if (Number(b.dataset.rounds) === savedTarget) restored = b;
    });
    if (restored) {
      lengthBtns.forEach((o) => {
        o.classList.toggle('selected', o === restored);
      });
      cpuTarget = savedTarget;
    }
  }

  $('#btn-back').addEventListener('click', () => show('lobby'));
  $('#btn-cancel').addEventListener('click', () => {
    transition('cancel');
    post('/cancel');
  });

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
      btn.disabled = true;
      if (!transition('climb')) btn.disabled = false;
      return;
    }
    if (lastMode === 'cpu') {
      $('#btn-again').disabled = true;
      // The match that just ended, not the lobby's current selection: "Play
      // Again" means the same match again. Falls back to the selection for a
      // server that reported no target, which is the same "older server" reading
      // as a result without the field.
      post('/cpu', { roundsTarget: lastTarget || cpuTarget }).then((res) => {
        if (!res || !res.ok) $('#btn-again').disabled = false;
      });
    } else {
      transition('rematch:online');
      post('/queue');
    }
  });
  $('#btn-mode').addEventListener('click', () => {
    transition('mode');
  });

  // The tower's own fight button: the same request the result screen's would have
  // made -- the floor the run is on, at the length just fought -- from the screen
  // the player is looking at now. The re-arm on failure is the guard the other two
  // entry points carry, because a rejected tap must not be a dead button.
  $('#ladder-fight').addEventListener('click', () => {
    const btn = $('#ladder-fight');
    if (btn.disabled) return;
    btn.disabled = true;
    const p = postCPU('ladder', { roundsTarget: lastTarget || cpuTarget });
    Promise.resolve(p).then((res) => {
      if (!res || !res.ok) btn.disabled = false;
    });
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