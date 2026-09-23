let CHARACTERS = [];

async function loadRoster() {
  try {
    const res = await fetch('/characters');
    if (!res.ok) throw new Error(`roster fetch: HTTP ${res.status}`);
    CHARACTERS = await res.json();
  } catch (e) {
    CHARACTERS = [];
  }
}

function characterByID(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

function saveCharacter(id) {
  try { localStorage.setItem('kxp-character', id); } catch (e) {}
}

function loadCharacter() {
  const def = CHARACTERS[0] && CHARACTERS[0].id;
  let id;
  try { id = localStorage.getItem('kxp-character'); } catch (e) { id = null; }
  return (id && characterByID(id)) ? id : def;
}