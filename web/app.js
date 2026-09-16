const aliases = { rock: '\u270a\uFE0F', paper: '\u270b\uFE0F', scissors: '\u270c\uFE0F' };

let id = null;
let phase = 'idle'; // idle | waiting | countdown | shoot | result
let es = null;
let shootTimer = null;

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
  if (n == null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<span class="dot"></span>${n} online now`;
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
  else if (d.youTimingMs != null) lines.push(`Your pick landed ${d.youTimingMs}ms after PUN!`);
  lines.push(`Opponent picked: ${oppAlias}`);

  $('#timing').innerHTML = lines.join('<br>');
  $('#timing').classList.remove('hidden');
  $('#btn-again').classList.remove('hidden');
  $('#opp').textContent = `vs ${d.opponentName || 'Opponent'}`;
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
    if (d.state === 'waiting') {
      phase = 'waiting';
      show('queue');
    } else if (d.state === 'ingame') {
      show('game');
      resetGame();
      if (d.phase === 'shoot') {
        phase = 'shoot';
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

  es.addEventListener('matched', () => {
    phase = 'countdown';
    show('game');
    resetGame();
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
    if (d.outcome === 'win') { s.wins++; s.streak++; } else { s.streak = 0; }
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
      post('/move', { move: b.dataset.move });
    });
  });
});
