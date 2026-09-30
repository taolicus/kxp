// Shared harness for the production probe suite.
//
// These scripts exist for one reason: the project is developed over a phone on
// a moving train, where connectivity is slow, lossy and bursty. Two rules shape
// everything here.
//
// 1. A failure is not automatically a bug. A TCP reset on a cellular link says
//    nothing about the server, so every fetch-level fault is classified as
//    NET and retried, while an HTTP status or a payload mismatch is a real
//    SERVER/ASSERT result. Conflating the two produces a suite that cries wolf
//    and gets ignored.
//
// 2. Report the timing, not just the verdict. Round-trip latency and the gap
//    between SSE frames is the signal that actually matters for this app: a
//    PUN window is 2s, so we need to know how much of a window survives the
//    network. Every script prints its latencies.
//
// Nothing here is Playwright-dependent and nothing boots the app locally: these
// talk to the deployed origin only. BASE_URL overrides the default.

export const BASE = (process.env.BASE_URL || 'https://redacted.invalid').replace(/\/+$/, '');

// Bounds are sized for a bad link, not for a datacenter. The server's own
// timing is matched+1s+1s+2s (see docs/protocol.md) and the client arms a 6s
// stall watchdog, so anything under ~10s of slack is not a real bound.
export const BOUNDS = {
  connect: 30000,   // TCP+TLS+first SSE frame
  http: 20000,      // a plain request/response
  countdown: 30000, // matched -> shoot
  match: 45000,     // full CPU match
  reconnect: 30000, // re-open /events and get a snapshot
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is this a transport fault (the link) or a real answer (the server)?
// Everything fetch throws without an HTTP status is the link: DNS, TLS,
// connection reset, idle timeout. Those are expected on a train and are
// retried rather than reported as defects.
const NET_ERR = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up|network|fetch failed|terminated|aborted|timeout/i;

export function classify(err) {
  if (err && err.__httpStatus === 429) return 'RATE';
  if (err && err.__httpStatus) return 'SERVER';
  return NET_ERR.test(String(err && err.message || err)) ? 'NET' : 'ASSERT';
}

export class HttpError extends Error {
  constructor(status, body, path) {
    super(`${path} -> HTTP ${status}: ${String(body).slice(0, 200)}`);
    this.__httpStatus = status;
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

async function request(method, path, body, { timeout = BOUNDS.http, signal } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeout);
  if (signal) signal.addEventListener('abort', () => ac.abort(new Error('timeout')), { once: true });
  const started = Date.now();
  try {
    const init = { method, signal: ac.signal, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, init);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not all responses are JSON */ }
    return { status: res.status, text, json, ms: Date.now() - started, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// Retry only transport faults. An HTTP status is the server's considered answer
// and is handed back immediately, so a genuine 500 is never masked by a retry.
export async function withRetry(fn, { tries = 3, baseDelay = 400, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(attempt); } catch (err) {
      lastErr = err;
      if (classify(err) === 'NET' && attempt < tries) {
        await sleep(baseDelay * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Error bodies are JSON: {"error":"..."} for every handlerError (server.go:288).
// The docs write them bare ("400 invalid character") so tests read the parsed
// field rather than the raw body, or every assertion fails on a quoting detail.
export const errMsg = (res) => {
  try { return JSON.parse(res.text)?.error ?? res.text; } catch { return res.text; }
};

export const get = (path, opts) => withRetry(() => request('GET', path, undefined, opts));
export const post = (path, body, opts) => withRetry(() => request('POST', path, body, opts));

// The rate limiter is a per-IP token bucket (200 burst, 2/sec refill) and a 429
// means this suite out-ran itself, not that the server is broken. Callers that
// expect a 2xx use this instead of post(), so a throttle surfaces as its own
// verdict rather than a mysterious mismatch.
export async function expectOk(promise) {
  const res = await promise;
  if (res.status === 429) throw new HttpError(429, res.text, 'rate limited');
  if (res.status !== 200) throw new HttpError(res.status, res.text, 'expected 200');
  return res;
}

// SSE client mirroring the browser: the deployed page uses a native
// EventSource (web/app.js:414), which reconnects on its own, and it re-reads the
// `connected` snapshot after every drop to reconcile state (web/app.js:416).
// This does the same over fetch, and additionally lets a test kill the stream on
// purpose to exercise that reconciliation.
export class Sse {
  constructor(id) {
    this.id = id;
    this.frames = [];   // every frame seen, in order, with arrival time
    this.buf = '';
    this.controller = null;
    this.closed = false;
    this.errors = [];
    this.waiters = [];
  }

  get path() { return `/events${this.id ? `?id=${encodeURIComponent(this.id)}` : ''}`; }

  async open({ timeout = BOUNDS.connect } = {}) {
    const ac = new AbortController();
    this.controller = ac;
    const started = Date.now();
    let res;
    try {
      res = await fetch(BASE + this.path, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
    } catch (err) {
      this.errors.push({ at: Date.now(), kind: 'open', message: String(err.message || err) });
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, text, this.path);
    }
    this.openMs = Date.now() - started;

    // Parsing runs detached: the caller awaits frames via wait(), and a parse
    // error or a mid-stream drop must not reject an already-awaited promise.
    this.pump(res, ac).catch((err) => {
      if (!this.closed) {
        this.errors.push({ at: Date.now(), kind: 'stream', message: String(err.message || err) });
      }
    });
    return this;
  }

  async pump(res, ac) {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        if (ac.signal.aborted) return;
        this.buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = this.buf.indexOf('\n\n')) !== -1) {
          const raw = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (!ev) continue; // ': ping' keepalive comment
          // A frame that fails to parse is recorded and skipped. It must never
          // escape into the read loop: an exception there tears the whole
          // stream down, the server reaps the abandoned connection, and every
          // later POST then reports "not connected" — a harness bug wearing a
          // server bug's clothes.
          let json;
          try { json = JSON.parse(data); } catch (err) {
            this.errors.push({ at: Date.now(), kind: 'parse', message: `unparsed '${ev}': ${String(data).slice(0, 80)}` });
            continue;
          }
          this.frames.push({ type: ev, data: json, at: Date.now() });
          // A server-assigned id is adopted exactly as the browser client does
          // (web/app.js:418-422), so later posts address the same session.
          if (ev === 'connected' && json && json.id && !this.id) this.id = json.id;
          this.notify();
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    }
  }

  notify() {
    // Must be total: any throw here propagates into the read loop and silently
    // destroys the stream. Waiters are removed before being resolved, and each
    // is resolved through its own stored reference.
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      const f = this.frames.slice(w.from).find((x) => x.type === w.type);
      if (!f) continue;
      this.waiters.splice(i, 1);
      w.resolve(f);
    }
  }

  // Resolve once a frame of `type` arrives at or after cursor `from`.
  // Default cursor is "now", so a test never consumes a frame it already saw.
  async wait(type, { timeout = BOUNDS.countdown, from = this.frames.length, where } = {}) {
    const hit = this.frames.slice(from).find((f) => f.type === type);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const waiter = {
        from,
        type,
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        const got = this.frames.slice(from).map((f) => f.type);
        const err = new Error(
          `timeout ${timeout}ms waiting for '${type}'${where ? ` (${where})` : ''}; saw: [${got.join(', ') || 'nothing'}]`
        );
        err.__seen = got;
        reject(err);
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  since(from = 0) { return this.frames.slice(from); }
  types(from = 0) { return this.frames.slice(from).map((f) => f.type); }

  // Capture a cursor BEFORE the action that provokes frames, then wait from it.
  // wait() defaults to "now", which silently hides any frame that lands between
  // the action and the call to wait() — and on a fast link that window is
  // exactly where `matched` lands, because /cpu starts the match instantly.
  // The failure looks like a missing frame the server never sent.
  mark() { return this.frames.length; }

  // Cursor just past an already-received frame, so the next wait() cannot
  // re-consume it. Index lookup rather than a timestamp, because two frames
  // can share a millisecond and a timestamp cursor is then ambiguous.
  marked(frame) {
    const i = this.frames.indexOf(frame);
    return i === -1 ? this.frames.length : i + 1;
  }

  // Simulate a dropped link. The next open() is the reconnect, exactly what
  // EventSource does and what the stall watchdog forces (web/app.js:28-31).
  drop() {
    this.closed = true;
    if (this.controller) this.controller.abort(new Error('dropped'));
  }
}

// Assertions. Each returns a check result so a script can report every finding
// instead of aborting on the first one.
export function makeReporter(title) {
  const checks = [];
  const t0 = Date.now();

  const ok = (name, detail = '') => { checks.push({ name, pass: true, detail }); return true; };
  const fail = (name, detail = '') => { checks.push({ name, pass: false, detail }); return false; };
  const eq = (name, actual, expected, detail = '') =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? ok(name, detail || `= ${JSON.stringify(actual)}`)
      : fail(name, detail || `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  const truthy = (name, value, detail = '') =>
    value ? ok(name, detail) : fail(name, detail || `falsy: ${JSON.stringify(value)}`);
  const within = (name, value, lo, hi) =>
    value >= lo && value <= hi
      ? ok(name, `${value} in [${lo}, ${hi}]`)
      : fail(name, `${value} outside [${lo}, ${hi}]`);

  return {
    checks,
    ok, fail, eq, truthy, within,
    get passed() { return checks.filter((c) => c.pass).length; },
    get failed() { return checks.filter((c) => !c.pass).length; },
    print(latency = {}) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n── ${title} ──`);
      for (const c of checks) {
        console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
      }
      const lat = Object.entries(latency)
        .map(([k, v]) => `${k} ${typeof v === 'number' ? v + 'ms' : v}`)
        .join(', ');
      if (lat) console.log(`  ·    latency: ${lat}`);
      console.log(`  ${this.failed ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${this.passed}/${checks.length} checks, ${secs}s`);
      return this.failed === 0;
    },
  };
}

// Entry point for a script: prints a header, runs the body, and turns any
// escaping throw into a classified verdict. A NET verdict is explicitly not a
// server defect, so a script can end "INCONCLUSIVE (link)" rather than red.
export async function script(name, body) {
  console.log(`\n${'='.repeat(60)}\n${name}  →  ${BASE}\n${'='.repeat(60)}`);
  const started = Date.now();
  try {
    const passed = await body();
    console.log(`  ·    total ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(passed ? 0 : 1);
  } catch (err) {
    const kind = classify(err);
    const label = {
      NET: 'INCONCLUSIVE (link dropped — not a server verdict)',
      RATE: 'INCONCLUSIVE (rate limited — this suite out-ran itself)',
      SERVER: 'FAIL (server responded badly)',
      ASSERT: 'FAIL (expectation not met)',
    }[kind];
    console.log(`\n  RESULT: ${label}\n  ${kind}: ${err.message}`);
    if (err.__seen) console.log(`  frames seen: [${err.__seen.join(', ')}]`);
    console.log(`  ·    total ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(2);
  }
}
