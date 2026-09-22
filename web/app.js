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
let chiTimer = null; // local CHI knockback for a dropped countdown frame
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
    es.close();
    connect();
  }, 6000);
}

const DEBUG = /[?&]debug/.test(location.search);
const GAME_STATES = ['countdown', 'shoot', 'locked'];
const BGS = ['pool', 'forest', 'tomb', 'arena', 'portal'];

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

// Advertise to the server that we're ready to receive the countdown; the
// server waits for both sides before the round begins, so a slow network can
// never drop us straight into an expired window. Re-posts while matched so a
// lost ack on a flaky link self-heals.
function readyLoop() {
  post('/ready');
  clearInterval(readyTimer);
  readyTimer = setInterval(() => {
    if (state !== 'matched') { stopReadyLoop(); return; }
    post('/ready');
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
  renderFighters();
  show('choose');
}

function fighterHTML(charId, label) {
  const c = characterByID(charId);
  return `<span class="slot-emoji">${c.emoji}</span><span>${label}</span>`;
}

function setYouSlot() {
  $('#you-slot').innerHTML = fighterHTML(loadCharacter(), 'YOU');
}

function setOppSlot(charId, name) {
  const label = name || (charId ? characterByID(charId).name : 'Opponent');
  if (charId) {
    $('#opp-slot').innerHTML = fighterHTML(charId, label);
  } else {
    $('#opp-slot').innerHTML = `<span class="slot-tag">${label}</span>`;
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
  clearTimeout(chiTimer);
  clearTimeout(punTimer);
  chiTimer = null;
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
  clearTimeout(chiTimer);
  clearTimeout(punTimer);
  plannedShootAt = d.shootAt;
  const plan = KXP.planRound(Date.now(), d.shootAt, d.windowMs, clockSkew);
  if (!plan) return;
  if (plan.msUntilChi > 0) {
    chiTimer = setTimeout(() => {
      if (state === 'countdown') setCount('CHI');
    }, plan.msUntilChi);
  }
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
  } catch (e) { return null; }
}

function transition(ev, data) {
  const to = SM.next(state, ev);
  if (!to) {
    if (DEBUG) console.warn(`kxp: no transition ${state} + ${ev}`);
    return false;
  }
  const from = state;
  state = to;
  if (enter[to]) enter[to](data || {}, from);
  return true;
}

const enter = {
  lobby() {
    stopReadyLoop();
    clearTimeout(stallTimer);
    resetGame();
    show('lobby');
  },

  waiting() {
    stopReadyLoop();
    clearTimeout(stallTimer);
    show('queue');
  },

  matched(d) {
    stopReadyLoop();
    clearTimeout(stallTimer);
    randomizeBg();
    showGame();
    resetGame();
    setYouSlot();
    setOppSlot(d.opponentCharacter || null, d.opponentName || 'Opponent');
    setCount('MATCH FOUND');
    readyLoop();
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
    setCount(d.n ?? 'Get ready');
    $('#stage').classList.remove('go');
    planFromCountdown(d);
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
        transition('snapshot:idle', d);
      }
      else transition(d.phase === 'shoot' ? 'snapshot:shoot' : 'snapshot:countdown', d);
    }
    else transition('snapshot:idle', d);
  });

  es.addEventListener('online', (e) => {
    setOnline(JSON.parse(e.data).count);
  });

  es.addEventListener('waiting', () => {
    transition('waiting');
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
    const s = JSON.parse(e.data).state;
    if (s === 'idle') transition('stateIdle');
    else transition('snapshot:waiting');
  });

  es.onerror = () => { /* EventSource auto-reconnects */ };
}

document.addEventListener('DOMContentLoaded', () => {
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
    if (pendingMode === 'online') {
      transition('queue');
      post('/queue');
    } else {
      post('/cpu');
    }
  });
  $('#btn-back').addEventListener('click', () => show('lobby'));
  $('#btn-cancel').addEventListener('click', () => {
    transition('cancel');
    post('/cancel');
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