// Loads the real web/app.js into a stubbed browser context, so client logic can
// be tested without a browser.
//
// Two test files share this rather than each carrying a copy: the countdown
// paint path and the SSE snapshot reconciler need the same DOM, clock and timer
// stubs, and a duplicated harness is a second copy that drifts — the same failure
// as the frontmatter schema this repo used to carry twice.
//
// The clock is stubbed rather than real and timers are queued rather than
// scheduled, so a test decides exactly when time passes. Nothing here sleeps.

const { readFileSync } = require('node:fs');
const { createContext, runInContext } = require('node:vm');
const { join } = require('node:path');

const APP = join(__dirname, 'app.js');
const CHARACTERS = join(__dirname, 'characters.js');
const KXP = require('./kxp.js');

function stubElement() {
  return {
    textContent: '',
    innerHTML: '',
    disabled: false,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
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
}

// loadApp builds a context around the real app.js with a controllable clock, a
// timer queue the test fires by hand, and a recording state machine.
//
// The state machine records every (from, event) pair it is asked about and
// returns null, so transition() declines and no enter[] handler runs. That is
// deliberate: it makes the routing decision itself the thing under test, with
// none of the DOM painting behind it. A test that wanted the painting too would
// pass `next` to return a real state.
function loadApp(opts = {}) {
  const timers = [];
  const sources = [];
  const transitions = [];
  const elements = new Map();
  let clock = 1700000000000;

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
    setInterval: (fn, ms) => {
      const t = { due: clock + (ms || 0), fn, every: ms || 0, id: timers.length };
      timers.push(t);
      return t;
    },
    clearInterval: (t) => {
      if (!t) return;
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    Image: function () { this.onload = null; this.onerror = null; this.src = ''; },
  });

  ctx.window = ctx;
  ctx.document = {
    documentElement: { style: { setProperty() {} } },
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    querySelector: (sel) => {
      if (!elements.has(sel)) elements.set(sel, stubElement());
      return elements.get(sel);
    },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  ctx.KXP = KXP;
  ctx.StateMachine = {
    next: (from, ev) => {
      transitions.push([from, ev]);
      return opts.next ? opts.next(from, ev) : null;
    },
  };
  // Per-source handler tables, so a reconnect does not leave the previous
  // connection's listeners reachable — which is the whole point of reconnecting.
  ctx.EventSource = function (url) {
    const s = {
      url,
      closed: false,
      handlers: new Map(),
      close() { this.closed = true; },
      addEventListener(type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type).push(fn);
      },
    };
    sources.push(s);
    return s;
  };

  // characters.js first: it only declares, and app.js calls loadCharacter() while
  // handling a snapshot, so the names have to exist before anything fires.
  runInContext(readFileSync(CHARACTERS, 'utf8'), ctx, { filename: 'characters.js' });
  runInContext(readFileSync(APP, 'utf8'), ctx, { filename: 'app.js' });

  return {
    ctx,
    sources,
    transitions,
    // The stub itself, for assertions on a property other than text.
    el: (sel) => elements.get(sel),
    html: (sel) => elements.get(sel)?.innerHTML,
    count: () => elements.get('#count')?.textContent,
    // Move the stubbed clock. Done from here rather than by reassigning Date.now
    // inside the context, which would detach the timers' due times from it.
    setClock: (ms) => { clock = ms; },
    // Deliver an SSE frame. The newest source is the live connection.
    fire(type, data, at = sources.length - 1) {
      for (const fn of sources[at].handlers.get(type) || []) fn({ data: JSON.stringify(data) });
    },
    // Fire every timer due strictly before the PUN deadline, in time order, and
    // stop there: the PUN timer would transition into enter.shoot(), which needs
    // far more DOM than this harness stubs, and is not what the countdown tests
    // are about. Counted after each fire, since a step paints synchronously.
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

module.exports = { loadApp };