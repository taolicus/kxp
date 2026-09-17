const CHARACTERS = [
  { id: 'scorpion', name: 'Scorpion', img: '/char/scorpion.svg' },
  { id: 'subzero', name: 'Sub-Zero', img: '/char/subzero.svg' },
  { id: 'raiden', name: 'Raiden', img: '/char/raiden.svg' },
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