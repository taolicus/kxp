// Drives the real web/app.js countdown paint path under test.
//
// The countdown chain is the part of the client that has actually broken twice:
// a stale paint, then a timer that armed once and never re-armed. Both bugs were
// invisible to every other check here -- kxp.js tests exercise the pure schedule
// helpers in isolation, and the protocol probes verify frames arriving on the
// wire, not the beats the client puts on screen. Neither can see whether
// app.js re-arms its timer.
//
// So this loads the actual app.js source into a stubbed browser context and
// watches #count. The countdown only touches setCount,
// timers and Date.now, all of which are stubbed below.

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');
const { join } = require('node:path');

const APP = join(__dirname, 'app.js');
const KXP = require('./kxp.js');

function stubElement() {
  const el = {
    textContent: '',
    innerHTML: '',
    disabled: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
    appendChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
  };
  return el;
}

// loadApp builds a context around the real app.js with a controllable clock and
// a timer queue the test fires by hand.
function loadApp() {
  const timers = [];
  let clock = 1700000000000;
  const elements = new Map();
  const ctx = createContext({
    console,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    navigator: { sendBeacon: () => true },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '' },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => {
      const t = { due: clock + (ms || 0), fn, id: timers.length };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (!t) return;
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  ctx.window = ctx;
  ctx.document = {
    documentElement: { style: {} },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelector: (sel) => {
      if (!elements.has(sel)) elements.set(sel, stubElement());
      return elements.get(sel);
    },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  ctx.KXP = KXP;
  ctx.StateMachine = { next: () => null };
  runInContext(readFileSync(APP, 'utf8'), ctx, { filename: 'app.js' });
  return {
    ctx,
    count: () => elements.get('#count')?.textContent,
    // Move the stubbed clock. Done from here rather than by reassigning Date.now
    // inside the context, which would detach the timers' due times from it.
    setClock: (ms) => { clock = ms; },
    // Fire every timer due strictly before the PUN deadline, in time order, and
    // stop there: the PUN timer would transition into enter.shoot(), which needs
    // far more DOM than this harness stubs, and is not what is under test.
    // Counted after each fire, since a step paints synchronously when it runs.
    runUntil(shootAt) {
      const painted = [this.count()];
      for (;;) {
        let next = null;
        for (const t of timers) {
          if (t.due < shootAt && (!next || t.due < next.due)) next = t;
        }
        if (!next) return painted;
        timers.splice(timers.indexOf(next), 1);
        clock = next.due;
        next.fn();
        painted.push(this.count());
      }
    },
  };
}

// announce replays what the server does: the first countdown frame opens the
// gate, and the later beats carry the same shootAt (which app.js dedupes).
function announce(app, shootAt, firstN) {
  const frames = [
    { n: firstN, shootAt, windowMs: 2000 },
    { n: 'KA', shootAt, windowMs: 2000 },
    { n: 'CHI', shootAt, windowMs: 2000 },
  ];
  for (const d of frames) {
    runInContext(`planFromCountdown(${JSON.stringify(d)})`, app.ctx);
  }
  return app.runUntil(shootAt);
}

test('app.js paints every countdown beat, not just the first two', () => {
  // The regression: the timer armed once, so READY then KA painted and CHI never
  // appeared -- the count jumped from KA straight to PUN. This asserts the full
  // sequence against the real source, so a one-shot timer fails here.
  const shootAt = 1700000003000;
  const app = loadApp();
  runInContext("state = 'countdown'", app.ctx);
  const painted = announce(app, shootAt, 'READY');
  assert.deepEqual(painted, ['READY', 'KA', 'CHI']);
});

test('app.js skips only the beats a late first frame has already passed', () => {
  // The delay this change exists for. Whatever has already gone is dropped;
  // everything still ahead must still be painted.
  for (const [lag, want] of [
    [0, ['READY', 'KA', 'CHI']],
    [1000, ['KA', 'CHI']],
    [2000, ['CHI']],
  ]) {
    const shootAt = 1700000003000;
    const app = loadApp();
    app.setClock(1700000000000 + lag); // first frame lands this late
    runInContext("state = 'countdown'", app.ctx);
    const painted = announce(app, shootAt, 'READY');
    assert.deepEqual(painted, want, `first frame +${lag}ms`);
  }
});

test('app.js dedupes the repeated countdown frames', () => {
  // The server sends every beat with the same shootAt. Feeding all of them must
  // not restart the chain or repaint, or the count would flicker backwards.
  const shootAt = 1700000003000;
  const app = loadApp();
  runInContext("state = 'countdown'", app.ctx);
  const painted = announce(app, shootAt, 'READY');
  assert.deepEqual(painted, ['READY', 'KA', 'CHI']);
  assert.equal(app.count(), 'CHI', 'count settles on the last beat before PUN');
});