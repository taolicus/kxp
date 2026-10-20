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

  // The ways to start something, each by the id app.js wires. A mode added
  // later belongs here too — and will fail this list until it is named.
  for (const id of ['btn-online', 'btn-cpu', 'btn-ladder']) {
    assert.ok(stack.includes(`id="${id}"`), `${id} is in the mode stack`);
  }
  assert.ok(!stack.includes('btn-history'),
    'Match History is not in the mode stack — it opens a record, not a match');
  assert.ok(!stack.includes('btn-challenge'),
    'Challenge a Friend is gone — Play Online is invite-first now');
});

test('Play Online ships live, not gated on the online count', () => {
  // Invite-first lets a lone player mint a code, so the button must not carry
  // the `disabled` it did when Play Online joined the FIFO. The unit tests seed
  // controls by selector and never read this file, and the browser suite asserts
  // flow, so nothing else would notice the attribute coming back.
  const lobby = lobbySection();
  const tag = /<button id="btn-online"[^>]*>/.exec(lobby);
  assert.ok(tag, 'the lobby carries Play Online');
  assert.ok(!/\bdisabled\b/.test(tag[0]), 'and it is not disabled in the shipped markup');
});

test('Match History sits before the mode selector, outside the stack', () => {
  const lobby = lobbySection();
  // Outside the stack, but present: the wiring looks the control up by id
  // (`app.js:1517`), so a move that dropped it would leave a dead listener on
  // nothing — and the stack test above would pass just as happily. It now sits
  // above the length control as well: the record is not a way to play, and the
  // mode choice reads as the last thing before the buttons it qualifies.
  const historyAt = lobby.indexOf('id="btn-history"');
  assert.ok(historyAt >= 0, 'the lobby still carries the control');
  assert.ok(historyAt < lobby.indexOf('id="cpu-length"'),
    'and it sits before the length control');
  const stack = innerOf(lobby, '<div class="buttons">');
  assert.ok(historyAt < lobby.indexOf(stack), 'and outside the mode stack, above it');
});

test('the stack orders the ways to play: online, arcade, cpu', () => {
  // The order is the lobby's own, so it is invisible to every other gate: the
  // harness seeds controls by selector and the browser suite asserts flow. Named
  // here in the sequence a player reads them, so a reorder is a deliberate edit
  // rather than a silent one.
  const lobby = lobbySection();
  const stack = innerOf(lobby, '<div class="buttons">');
  const ids = ['btn-online', 'btn-ladder', 'btn-cpu'];
  const at = ids.map((id) => stack.indexOf(`id="${id}"`));
  ids.forEach((id, n) => assert.ok(at[n] >= 0, `${id} is in the mode stack`));
  for (let n = 1; n < at.length; n++) {
    assert.ok(at[n - 1] < at[n], `${ids[n - 1]} comes before ${ids[n]}`);
  }
});

// Numeric character references, because this file keeps glyphs as entities so
// the markup stays ASCII. Resolved before any two glyphs are compared, or the
// comparison reads "&#x270A;" against "✊" and fails on the encoding rather
// than on the mark.
function codepointsOf(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// What of that text is neither markup nor an ASCII character: the emoji, in a
// list, so two of them can be compared by value rather than by source spelling.
function nonASCII(text) {
  return [...text].filter((ch) => ch.codePointAt(0) > 0x7f);
}

test('the lobby wears the favicon\'s fist, above the title', () => {
  // The mark on the page and the mark in the tab are one glyph, not two that
  // happen to agree today: the icon is an inline SVG drawing U+270A, so a
  // favicon swap that left the landing screen behind would ship two marks at
  // once. Pinned in this file because nothing else would notice either half —
  // the harness seeds controls by selector and never reads index.html, and the
  // browser suite asserts flow rather than structure.
  const lobby = lobbySection();

  const fistAt = lobby.indexOf('id="lobby-fist"');
  assert.ok(fistAt >= 0, 'the lobby carries the emblem');
  assert.ok(fistAt < lobby.indexOf('<h1 class="mkx-title">'),
    'and it sits above the title');

  // Decorative, and said so: without aria-hidden a reader hears "raised fist"
  // before the title it repeats.
  const tag = /<div id="lobby-fist"[^>]*>/.exec(lobby);
  assert.ok(tag, 'the emblem is a div the stylesheet can size');
  assert.ok(/\baria-hidden="true"/.test(tag[0]), 'and it is hidden from the accessibility tree');

  // The icon: one percent-encoded data URI, decoded back to the glyph it draws.
  const icon = /<link rel="icon" href="data:image\/svg\+xml,([^"]+)">/.exec(html);
  assert.ok(icon, 'the tab icon is still the inline SVG data URI');
  const iconEmoji = nonASCII(codepointsOf(decodeURIComponent(icon[1])));
  assert.equal(iconEmoji.length, 1, 'and it draws exactly one non-ASCII glyph');

  // The emblem's own text, resolved the same way.
  const mark = /id="lobby-fist"[^>]*>([^<]*)</.exec(lobby);
  assert.ok(mark, 'the emblem carries a glyph, not an image');
  const lobbyEmoji = nonASCII(codepointsOf(mark[1]));
  assert.deepEqual(lobbyEmoji, iconEmoji,
    'the landing screen\'s fist is the same codepoint the tab shows');
});

test('the length control relies on its buttons, not a visible label', () => {
  // "Mode:" collided with the "Arcade Mode" button, and "Length:" restated what
  // "1 round" / "First to 3" already say. The control carries no visible label;
  // its accessible name is the group's aria-label, so a screen reader still
  // hears what it chooses. Pinned because a stray span is easy to add back and
  // nothing else in the tree would notice.
  const lobby = lobbySection();
  assert.ok(!lobby.includes('seg-label'), 'no visible label on the length control');
  assert.ok(lobby.includes('id="cpu-length" class="seg" role="group" aria-label="Match length"'),
    'the accessible name still says what the control chooses');
});
