// Pins the lobby's markup grouping: the ways to start a match live in the
// `.buttons` stack, and Match History — which opens a record that already
// exists and posts nothing — is not one of them.
//
// The grouping is the whole of the change, and it is invisible to every other
// gate: the client harness does not read index.html (controls are seeded by
// selector), so an app.js-driven test cannot see a button move between
// containers, and the browser suite asserts flow rather than structure. This
// file reads the markup itself, so dropping `#btn-history` back into the mode
// stack fails here.

const test = require('node:test');
const assert = require('node:assert');

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, 'index.html'), 'utf8');

// The lobby section, from its opening tag to the next section — everything
// after the game view is outside it, so a bounded slice is enough.
function lobbySection() {
  const from = html.indexOf('<section id="lobby"');
  assert.ok(from >= 0, 'index.html has a lobby section');
  const to = html.indexOf('<section', from + 1);
  return html.slice(from, to > 0 ? to : html.length);
}

// A div's inner text by tag balance: the lobby's `.buttons` stack may not nest
// divs today, but a test that assumed it would silently read a sibling's
// contents the first time somebody added one.
function innerOf(section, openTag) {
  const start = section.indexOf(openTag);
  assert.ok(start >= 0, `lobby holds ${openTag}`);
  let depth = 0;
  let i = start;
  for (;;) {
    const nextOpen = section.indexOf('<div', i + 1);
    const nextClose = section.indexOf('</div>', i + 1);
    assert.ok(nextClose >= 0, `${openTag} closes`);
    if (nextOpen >= 0 && nextOpen < nextClose) { depth += 1; i = nextOpen; continue; }
    depth -= 1;
    i = nextClose;
    if (depth <= 0) return section.slice(start, nextClose + '</div>'.length);
  }
}

test('the lobby stack holds the ways to start a match, and nothing else', () => {
  const lobby = lobbySection();
  const stack = innerOf(lobby, '<div class="buttons">');

  // The four ways to start something, each by the id app.js wires. A mode
  // added later belongs here too — and will fail this list until it is named.
  for (const id of ['btn-online', 'btn-cpu', 'btn-ladder', 'btn-challenge']) {
    assert.ok(stack.includes(`id="${id}"`), `${id} is in the mode stack`);
  }
  assert.ok(!stack.includes('btn-history'),
    'Match History is not in the mode stack — it opens a record, not a match');
});

test('Match History is still on the lobby, as its own control', () => {
  const lobby = lobbySection();
  // Outside the stack, but present: the wiring looks the control up by id
  // (`app.js:1517`), so a move that dropped it would leave a dead listener on
  // nothing — and the stack test above would pass just as happily.
  assert.ok(lobby.includes('id="btn-history"'), 'the lobby still carries the control');
  const stack = innerOf(lobby, '<div class="buttons">');
  assert.ok(lobby.indexOf('id="btn-history"') > lobby.indexOf(stack) + stack.length,
    'and it sits after the stack ends, not inside it');
});

test('the length control is labelled for what it chooses', () => {
  // "Mode:" answered to two controls at once — this one and the "Arcade Mode"
  // button below it — while it actually chooses the match length (and the draw
  // rule that rides with it). The label names the axis now. Pinned because the
  // ambiguous word is a one-edit revert and nothing else in the tree would
  // notice it come back.
  const lobby = lobbySection();
  const label = /<span class="seg-label">([^<]*)<\/span>/.exec(lobby);
  assert.ok(label, 'the control carries a label');
  assert.strictEqual(label[1], 'Length:', 'the control names the length, not a mode');
});
