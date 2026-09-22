const CHARACTERS = [
  { id: 'scorpion', name: 'Alakran', emoji: '🦂' },
  { id: 'subzero', name: 'Hielito', emoji: '🧊' },
  { id: 'raiden', name: 'Rayito', emoji: '⚡' },
  { id: 'liukang', name: 'Fueguito', emoji: '🔥' },
  { id: 'smoke', name: 'Humito', emoji: '💨' },
  { id: 'reptile', name: 'Lagartijo', emoji: '🦎' },
  { id: 'jax', name: 'Bracitos', emoji: '💪' },
  { id: 'kitana', name: 'Abaniquita', emoji: '🪭' },
  { id: 'baraka', name: 'Navajita', emoji: '🗡️' },
];

function characterByID(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

function saveCharacter(id) {
  try { localStorage.setItem('kxp-character', id); } catch (e) {}
}

function loadCharacter() {
  try { return localStorage.getItem('kxp-character') || CHARACTERS[0].id; } catch (e) { return CHARACTERS[0].id; }
}