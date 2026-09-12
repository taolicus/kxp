const aliases = { rock: '\u270a', paper: '\u270b', scissors: '\u270c' };

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
  else if (d.youTimingMs != null) lines.push(`Your pick landed ${d.youTimingMs}ms after SHOOT!`);
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
    if (d.state === 'waiting') {
      phase = 'waiting';
      show('queue');
    } else if (d.state === 'ingame') {
      show('game');
      resetGame();
      if (d.phase === 'shoot') {
        phase = 'shoot';
        setCount('SHOOT!');
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
    setCount('SHOOT!');
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
    renderResult(JSON.parse(e.data));
  });

  es.addEventListener('opponent-left', () => {
    phase = 'result';
    clearTimeout(shootTimer);
    lockMoves();
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

  $('#btn-online').addEventListener('click', () => post('/queue'));
  $('#btn-cpu').addEventListener('click', () => post('/cpu'));
  $('#btn-cancel').addEventListener('click', () => post('/cancel'));

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