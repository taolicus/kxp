const aliases = { rock: '\u270a\uFE0F', paper: '\u270b\uFE0F', scissors: '\u270c\uFE0F' };
const SM = window.StateMachine;

let id = null;
let state = 'lobby'; // lobby | waiting | countdown | shoot | locked | result
let lastMode = 'online'; // online | cpu — mode of the finished match
let es = null;
let shootTimer = null;
let punWindowMs = 2000;
let sawPunAt = 0;

const DEBUG = /[?&]debug/.test(location.search);
const GAME_STATES = ['countdown', 'shoot', 'locked'];
const BGS = ['pool', 'forest', 'tomb'];

const $ = (sel) => document.querySelector(sel);

function randomizeBg() {
  const bg = BGS[Math.floor(Math.random() * BGS.length)];
  const r = document.documentElement.style;
  r.setProperty('--bg-anim', `url('/img/bg/${bg}.webp')`);
  r.setProperty('--bg-static', `url('/img/bg/${bg}-static.webp')`);
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
    return { wins: Number(s.wins) || 0, streak: Number(s.streak) || 0, best: Number(s.best) || 0 };
  } catch (e) {
    return { wins: 0, streak: 0, best: 0 };
  }
}

function saveStats(s) {
  try { localStorage.setItem('kxp-stats', JSON.stringify(s)); } catch (e) {}
}

function setStats() {
  const s = getStats();
  const text = `${s.wins} wins \u00b7 ${s.streak} in a row \u00b7 best streak ${s.best}`;
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
  sawPunAt = 0;
  $('#banner').classList.add('hidden');
  $('#timing').classList.add('hidden');
  $('#game-stats').classList.add('hidden');
  $('#btn-again').classList.add('hidden');
  $('#btn-mode').classList.add('hidden');
  flashPick(null);
  setCount('\u200b');
}

function banner(html) {
  $('#banner').innerHTML = html;
  $('#banner').classList.remove('hidden');
}

function renderResult(d) {
  const cls = d.outcome === 'win' ? 'won' : d.outcome === 'loss' ? 'lost' : 'draw';
  const lbl = d.note || (d.outcome === 'win' ? 'You win!' : d.outcome === 'loss' ? 'You lose' : 'Draw!');
  banner(`<p class="${cls}">${lbl}</p>`);

  const lines = [];
  if (d.you || d.opponent) {
    const oppAlias = d.opponent ? aliases[d.opponent] : '\u2014';
    const oppMs = d.opponentClientMs != null ? d.opponentClientMs : d.opponentTimingMs;
    if (d.yourNote === 'timeout') lines.push('Timed out \u2014 no pick.');
    else if (d.yourNote === 'early') lines.push(`Disqualified \u2014 ${-d.youTimingMs}ms early.`);
    else {
      const youAlias = d.you ? aliases[d.you] : '\u2014';
      const youMs = d.youClientMs != null ? d.youClientMs : d.youTimingMs;
      lines.push(`You picked: ${youAlias}${youMs != null ? ` (${youMs}ms)` : ''}`);
    }
    lines.push(`Opponent picked: ${oppAlias}${oppMs != null ? ` (${oppMs}ms)` : ''}`);
  }

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
    resetGame();
    show('lobby');
  },

  waiting() {
    show('queue');
  },

  countdown(d, from) {
    show('game');
    if (!GAME_STATES.includes(from)) {
      randomizeBg();
      resetGame();
      setYouSlot();
      setOppSlot(d.opponentCharacter || null, d.opponentName || 'Opponent');
    } else if (d.opponentCharacter) {
      setOppSlot(d.opponentCharacter, d.opponentName);
    }
    setCount(d.n ?? 'Get ready');
    $('#stage').classList.remove('go');
  },

  shoot(d, from) {
    show('game');
    if (!GAME_STATES.includes(from)) {
      randomizeBg();
      resetGame();
      setYouSlot();
      setOppSlot(null, 'Opponent');
    }
    sawPunAt = Date.now();
    if (d.windowMs) punWindowMs = d.windowMs;
    setCount('PUN!');
    $('#stage').classList.add('go');
    enableMoves();
    clearTimeout(shootTimer);
    shootTimer = setTimeout(() => transition('lock'), punWindowMs);
  },

  locked(d) {
    lockMoves();
    if (d.move) flashPick(d.move);
    if (d.error) {
      const label = d.error === 'too early' ? 'TOO EARLY!'
        : d.error === 'too late' ? 'TOO LATE!'
        : d.error === 'move already submitted' ? 'ALREADY PICKED'
        : 'NOT ACCEPTED';
      setCount(label);
      $('#stage').classList.add('go');
    }
  },

  result(d) {
    clearTimeout(shootTimer);
    lockMoves();
    lastMode = d.mode || 'online';
    const s = getStats();
    if (d.outcome === 'win') {
      s.wins++;
      s.streak++;
      if (s.streak > s.best) s.best = s.streak;
    } else if (d.outcome === 'loss') { s.streak = 0; }
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
    post('/character', { character: loadCharacter() });
    if (d.state === 'waiting') transition('snapshot:waiting', d);
    else if (d.state === 'ingame') transition(d.phase === 'shoot' ? 'snapshot:shoot' : 'snapshot:countdown', d);
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

  $('#btn-online').addEventListener('click', () => {
    transition('queue');
    post('/queue');
  });
  $('#btn-cpu').addEventListener('click', () => post('/cpu'));
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