const CHARACTERS = [
  { id: 'scorpion', name: 'Alakran', emoji: '🦂' },
  { id: 'liukang', name: 'Fueguito', emoji: '🔥' },
  { id: 'johnnycage', name: 'Galancito', emoji: '🕶️' },
  { id: 'kunglao', name: 'Sombrerito', emoji: '🎩' },
  { id: 'kitana', name: 'Abaniquita', emoji: '🪭' },
  { id: 'mileena', name: 'Colmillita', emoji: '🦷' },
  { id: 'reptile', name: 'Lagartijo', emoji: '🦎' },
  { id: 'subzero', name: 'Hielito', emoji: '🧊' },
  { id: 'jax', name: 'Bracitos', emoji: '💪' },
  { id: 'baraka', name: 'Navajita', emoji: '🗡️' },
  { id: 'shangtsung', name: 'Abuelito', emoji: '🧙' },
  { id: 'smoke', name: 'Humito', emoji: '💨' },
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