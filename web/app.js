const aliases = { rock: '\u270a\uFE0F', paper: '\u270b\uFE0F', scissors: '\u270c\uFE0F' };

let id = null;
let phase = 'idle'; // idle | waiting | countdown | shoot | result
let es = null;
let shootTimer = null;
let sawPunAt = 0;

const $ = (sel) => document.querySelector(sel);

function show(view) {
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== view);
  });
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
    return { wins: Number(s.wins) || 0, streak: Number(s.streak) || 0 };
  } catch (e) {
    return { wins: 0, streak: 0 };
  }
}

function saveStats(s) {
  try { localStorage.setItem('kxp-stats', JSON.stringify(s)); } catch (e) {}
}

function setStats() {
  const s = getStats();
  const el = $('#stats');
  if (!el) return;
  el.textContent = `${s.wins} wins \u00b7 ${s.streak} in a row`;
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
  phase = 'idle';
  sawPunAt = 0;
  $('#banner').classList.add('hidden');
  $('#timing').classList.add('hidden');
  $('#btn-again').classList.add('hidden');
  flashPick(null);
  setCount('\u200b');
}

function banner(html) {
  $('#banner').innerHTML = html;
  $('#banner').classList.remove('hidden');
}

function renderResult(d) {
  const oppAlias = d.opponent ? aliases[d.opponent] : '\u2014';
  const cls = d.outcome === 'win' ? 'won' : d.outcome === 'loss' ? 'lost' : 'draw';
  const lbl = d.outcome === 'win' ? 'You win!' : d.outcome === 'loss' ? 'You lose' : 'Draw!';
  banner(`<p class="${cls}">${lbl}</p>`);

  const lines = [];
  if (d.yourNote === 'timeout') lines.push('Timed out \u2014 no pick.');
  else if (d.yourNote === 'early') lines.push(`Disqualified \u2014 ${-d.youTimingMs}ms early.`);
  else if (d.youClientMs != null) lines.push(`Your pick landed ${d.youClientMs}ms after PUN!`);
  else if (d.youTimingMs != null) lines.push(`Your pick landed ${d.youTimingMs}ms after PUN!`);
  const oppMs = d.opponentClientMs != null ? d.opponentClientMs : d.opponentTimingMs;
  lines.push(`Opponent picked: ${oppAlias}${oppMs != null ? ` (${oppMs}ms)` : ''}`);

  $('#timing').innerHTML = lines.join('<br>');
  $('#timing').classList.remove('hidden');
  $('#btn-again').classList.remove('hidden');
  setYouSlot();
  setOppSlot(d.opponentCharacter, d.opponentName);
}

async function post(path, body = {}) {
  if (!id) return;
  try {
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    });
  } catch (e) { /* ignore */ }
}

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
    if (d.state === 'waiting') {
      phase = 'waiting';
      show('queue');
    } else if (d.state === 'ingame') {
      show('game');
      resetGame();
      setYouSlot();
      setOppSlot(null, 'Opponent');
      if (d.phase === 'shoot') {
        phase = 'shoot';
        sawPunAt = Date.now();
        setCount('PUN!');
        $('#stage').classList.add('go');
        enableMoves();
      } else {
        phase = 'countdown';
        setCount('Get ready');
      }
    } else {
      phase = 'idle';
      show('lobby');
    }
  });

  es.addEventListener('online', (e) => {
    setOnline(JSON.parse(e.data).count);
  });

  es.addEventListener('waiting', () => {
    phase = 'waiting';
    show('queue');
  });

  es.addEventListener('matched', (e) => {
    const d = JSON.parse(e.data);
    phase = 'countdown';
    show('game');
    resetGame();
    setYouSlot();
    setOppSlot(d.opponentCharacter, d.opponentName);
    setCount('Get ready');
  });

  es.addEventListener('countdown', (e) => {
    const n = JSON.parse(e.data).n;
    phase = 'countdown';
    setCount(n);
    $('#stage').classList.remove('go');
  });

  es.addEventListener('shoot', () => {
    phase = 'shoot';
    sawPunAt = Date.now();
    setCount('PUN!');
    $('#stage').classList.add('go');
    enableMoves();
    clearTimeout(shootTimer);
    shootTimer = setTimeout(() => {
      if (phase === 'shoot') { phase = 'locked'; lockMoves(); }
    }, 1500);
  });

  es.addEventListener('result', (e) => {
    phase = 'result';
    clearTimeout(shootTimer);
    lockMoves();
    const d = JSON.parse(e.data);
    const s = getStats();
    if (d.outcome === 'win') { s.wins++; s.streak++; } else if (d.outcome === 'loss') { s.streak = 0; }
    saveStats(s);
    setStats();
    renderResult(d);
  });

  es.addEventListener('opponent-left', () => {
    phase = 'result';
    clearTimeout(shootTimer);
    lockMoves();
    const s = getStats();
    s.wins++; s.streak++;
    saveStats(s);
    setStats();
    banner('<p class="won">Opponent left \u2014 you win!</p>');
    $('#btn-again').classList.remove('hidden');
  });

  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data).state;
    if (s === 'idle' && phase !== 'result') {
      phase = 'idle';
      show('lobby');
    } else if (s === 'waiting') {
      phase = 'waiting';
      show('queue');
    }
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

  $('#btn-online').addEventListener('click', () => post('/queue'));
  $('#btn-cpu').addEventListener('click', () => post('/cpu'));
  $('#btn-cancel').addEventListener('click', () => {
    if (phase === 'waiting') { phase = 'idle'; show('lobby'); }
    post('/cancel');
  });

  $('#btn-again').addEventListener('click', () => {
    resetGame();
    show('lobby');
  });

  document.querySelectorAll('.move').forEach((b) => {
    b.addEventListener('click', () => {
      if (phase !== 'shoot') return;
      phase = 'locked';
      lockMoves();
      flashPick(b.dataset.move);
      post('/move', { move: b.dataset.move, clickedAt: Date.now(), sawPunAt });
    });
  });
});
