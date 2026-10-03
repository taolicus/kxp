const KXP = window.KXP;
const SM = window.StateMachine;

let id = null;
let state = 'lobby'; // lobby | waiting | countdown | shoot | locked | result
let lastMode = 'online'; // online | cpu — mode of the finished match
let pendingMode = null; // online | cpu — mode picked on the lobby, awaiting fighter confirmation
let es = null;
let shootTimer = null;
let remainingWindowMs = 2000; // local portion of the PUN window still open
let sawPunAt = 0;
let clockSkew = 0; // serverNow - clientNow, estimated from the connected snapshot
let stallTimer = null;
let slotTimer = null; // advances the local countdown beat when a countdown frame is dropped
let punTimer = null; // local PUN entry scheduled from the announced round plan
let plannedShootAt = 0; // announced deadline (epoch-ms) this punTimer belongs to

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

function randomizeBg() {
  const bg = BGS[Math.floor(Math.random() * BGS.length)];
  bgReady = preloadBg(bg).then(() => {
    const r = document.documentElement.style;
    r.setProperty('--bg-anim', `url('/img/bg/${bg}.webp')`);
    r.setProperty('--bg-static', `url('/img/bg/${bg}-static.webp')`);
    return bg;
  });
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

// Show or hide the ready prompt. Driven off the state machine in transition(),
// so it cannot disagree with the phase -- the prompt is only ever up while the
// client is actually matched and waiting.
function setReadyPrompt(on) {
  const btn = $('#btn-ready');
  if (!btn) return;
  btn.classList.toggle('hidden', !on);
  btn.disabled = false;
}

// Re-posts while matched so a lost ack on a flaky link self-heals.
//
// Armed by the tap, never by the match. The ack used to be posted automatically
// from the matched handler, which meant it proved only that bytes had reached the
// browser: a phone with the app backgrounded acked just as reliably as one being
// looked at, and the round then fired at an absent player. Now a person says go,
// and this only keeps that decision alive until the server hears it.
//
// The gate is still a buffer, not a guarantee, and the cost is a lost round: if
// the link is too slow to deliver an ack within the server's 8s, it cancels the
// pending match and sends `state idle`, which drops us back to the lobby with a
// reason shown. That is now likelier to mean "nobody tapped" than "slow link".
function armReadyLoop() {
  stopReadyLoop();
  readyTimer = setInterval(() => {
    if (state !== 'matched') { stopReadyLoop(); return; }
    sendReady();
  }, 2000);
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
  plannedShootAt = 0;
  sawPunAt = 0;
  $('#banner').classList.add('hidden');
  $('#timing').classList.add('hidden');
  $('#game-stats').classList.add('hidden');
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
function planFromCountdown(d) {
  if (!d.shootAt) return; // pre-announce unseen — fall back to frame-driven play
  if (d.shootAt === plannedShootAt) return; // duplicate countdown for this round
  clearTimeout(slotTimer);
  clearTimeout(punTimer);
  plannedShootAt = d.shootAt;
  const plan = KXP.planRound(Date.now(), d.shootAt, d.windowMs, clockSkew);
  if (!plan) return;
  // The deadline decides what is on screen, not the frame that named it. A
  // countdown frame that arrives late must not paint a beat with no time behind
  // it: that beat would be overwritten in the same tick by an already-due
  // transition, so the count would jump straight to PUN and the player would
  // see no countdown at all even though the server had announced one and the
  // pick window was still open. countdownSchedule yields whichever beats are
  // genuinely still ahead, so a frame delayed past its own beat degrades to the
  // next real beat instead of flashing a dead one.
  //
  // The timer re-arms on every step rather than firing once. The later
  // countdown frames carry the same shootAt and are deduped above, so this
  // chain is the only thing advancing the beat; a one-shot timer stopped after
  // the first step and the tail of the countdown was never painted.
  const steps = KXP.countdownSchedule(() => Date.now(), d.shootAt, d.windowMs, clockSkew);
  const step = () => {
    const next = steps.next();
    if (next.done) return;
    if (next.value.label && state === 'countdown') setCount(next.value.label);
    if (next.value.delay > 0) slotTimer = setTimeout(step, next.value.delay);
  };
  step();
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
  $('#btn-again').classList.remove('hidden');
  $('#btn-again').disabled = false;
  $('#btn-mode').classList.remove('hidden');
  setYouSlot();
  setOppSlot(d.opponentCharacter, d.opponentName);
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
  setReadyPrompt(to === 'matched');
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
    randomizeBg();
    showGame();
    resetGame();
    setYouSlot();
    setOppSlot(d.opponentCharacter || null, d.opponentName || 'Opponent');
    setCount('TAP READY');
  },

  countdown(d, from) {
    clearTimeout(stallTimer);
    if (from === 'matched') {
      stopReadyLoop();
      showGame();
    } else if (!GAME_STATES.includes(from)) {
      randomizeBg();
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
      randomizeBg();
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
    const s = KXP.applyResult(getStats(), d.outcome);
    saveStats(s);
    setStats();
    renderResult(d);
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
      } else if (d.phase === 'countdown' && d.pending) transition('snapshot:matched', d);
      else if (d.phase === 'shoot' && d.shootAt && d.windowMs && Date.now() + clockSkew - d.shootAt >= d.windowMs) {
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
      if (state === 'result') return;
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
    const p = post(mode === 'online' ? '/queue' : '/cpu');
    Promise.resolve(p).then((res) => {
      if (res && res.ok) return;
      btn.disabled = false;
      pendingMode = mode;
      if (res && res.status === 409) setNotice('You are already in a match.');
    });
  });
  $('#btn-back').addEventListener('click', () => show('lobby'));
  $('#btn-cancel').addEventListener('click', () => {
    transition('cancel');
    post('/cancel');
  });

  $('#btn-ready').addEventListener('click', () => {
    const btn = $('#btn-ready');
    // Re-checked per tap: a double-tap on a phone must not post twice, and a
    // prompt left up over a live countdown must not be tappable into the window.
    if (state !== 'matched' || btn.disabled) return;
    btn.disabled = true;
    setCount('READY…');
    sendReady();
    armReadyLoop();
  });

  $('#btn-again').addEventListener('click', () => {
    if (lastMode === 'cpu') {
      $('#btn-again').disabled = true;
      post('/cpu').then((res) => {
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