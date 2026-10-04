// Checks web/diag.html, the link-check page a player opens on their phone when
// the countdown goes missing.
//
// The page is the only way this repo can measure a real player's delivery lag --
// the probes see frames arriving but cannot measure delivery against a send
// time, and there is no /ping to do it with. So the page's conclusions are load
// bearing: if its arithmetic drifts, it tells a player their countdown is fine
// when it is not, which is worse than having no tool.
//
// Two things are checked. The inline script has to parse, since it is browser
// JavaScript that nothing else in this repo loads (node --test never touches it,
// and go vet never sees it) -- a syntax error there produces a blank page and
// nothing anywhere turns red. And verdictFor() has to map measured lateness onto
// the same bands the schedule actually produces, which
// app.countdown.test.cjs pins from the other direction.
//
// The script is run in a stubbed DOM rather than parsed off disk alone, because
// the verdict lives inside it and reading the file proves nothing about whether
// it can run.

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { createContext, runInContext, Script } = require('node:vm');
const { join } = require('node:path');

const KXP = require('./kxp.js');

const HTML = readFileSync(join(__dirname, 'diag.html'), 'utf8');

// The inline block is the one without a src attribute; the other is /kxp.js,
// which the page loads to drive the real countdown schedule.
function inlineScript() {
  const blocks = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length, 'diag.html has an inline script');
  return blocks[blocks.length - 1][1];
}

function stubEl() {
  return {
    textContent: '', innerHTML: '', className: '', hidden: false, disabled: false,
    style: { width: '' }, children: [],
    addEventListener() {}, insertBefore(t) { this.children.unshift(t); },
    appendChild(t) { this.children.push(t); },
  };
}

// load runs the page's script for real, against a DOM that does nothing, so
// verdictFor can be called directly with synthetic frame logs.
function load() {
  const els = new Map();
  const ctx = createContext({
    console, KXP,
    setTimeout: () => 0, clearTimeout: () => {}, Date: { now: () => 1700000000000 },
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    fetch: () => Promise.resolve({ ok: true }),
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      createElement: () => stubEl(),
    },
  });
  runInContext(inlineScript(), ctx);
  return runInContext('verdictFor', ctx);
}

// rows replays one client's countdown frames arriving `late` ms after send,
// staggered a second apart as the server sends them.
function rows(late) {
  return ['READY', 'KA', 'CHI'].map((beat, i) => ({
    side: 'A', frame: 'countdown', beat, lateMs: late + i * 1000,
  }));
}

test('the diag page script parses', () => {
  assert.doesNotThrow(() => new Script(inlineScript()));
});

test('diag.html drives the real schedule rather than restating it', () => {
  // The page must load /kxp.js, or it is carrying its own copy of the countdown
  // arithmetic -- a second copy that drifts, and one that would then disagree
  // with what the player actually sees.
  assert.match(HTML, /<script src="\/kxp\.js"><\/script>/);
  assert.match(inlineScript(), /KXP\.countdownPainter/);
});

test('diag.html reports lost beats to match what the schedule actually does', () => {
  // The bands come from the envelope app.countdown.test.cjs pins: the lead
  // before PUN equals the countdown length, so each second of delay costs one
  // beat. 2999ms still paints CHI; 3000ms paints nothing.
  const verdictFor = load();
  for (const [late, want] of [
    [10, /kept the whole countdown/i],
    [1000, /drops about 1 of the 3/i],
    [2000, /drops about 2 of the 3/i],
    [2999, /drops about 2 of the 3/i],
    [3000, /ate the whole countdown/i],
    [3400, /ate the whole countdown/i],
  ]) {
    const out = strip(verdictFor(rows(late)).html);
    assert.match(out, want, `first frame +${late}ms late`);
  }
});

test('diag.html does not blame a healthy link', () => {
  // The negative direction. A tool that reports trouble on a fast link is worse
  // than no tool, because it sends the reader off chasing a server bug that is
  // not there -- so a sub-second link must be called healthy, and must not be
  // handed a "needs N seconds of slack" figure.
  const verdictFor = load();
  const out = strip(verdictFor(rows(250)).html);
  assert.match(out, /kept the whole countdown/i);
  assert.doesNotMatch(out, /slower than/i);
});

test('diag.html says so when no match formed, instead of guessing', () => {
  // Two clients that failed to pair produce no countdown frames at all. The page
  // must report the measurement failed rather than falling through to a
  // conclusion about the link.
  const verdictFor = load();
  const out = strip(verdictFor([]).html);
  assert.match(out, /no countdown frames arrived/i);
  assert.doesNotMatch(out, /slack|countdown beats/i);
});

function strip(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}