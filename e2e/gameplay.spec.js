// Core-gameplay e2e: three deliberately narrow flows that drive the real
// browser against the real server over SSE, surfaced by Playwright on a
// host where Chromium exists (see README / package.json scripts).
//
// The flows are scoped by the roadmap (item 8) to the *game-breaking
// connectivity failures that resist unit testing*:
//
//   1. a CPU match completes end-to-end within a hard bound, with zero
//      console/page errors;
//   2. a self-PvP match in two isolated contexts produces a consistent
//      result on both sides, neither left dead in matched/countdown (the
//      asymmetric-SSE class);
//   3. a reload mid-match reconciles the client to a healthy state and the
//      page is never stuck on a dead "Waiting for result…" view.
//
// No button/stat/styling assertions, per scope.
//
// Runtime notes
// -------------
// A finished match leaves the client on the result screen (the machine has no
// result→stateIdle edge; "Play Again / Change mode" waits for the player), so
// the suite keys completion off `#btn-again` arming after `renderResult`
// (captured through a deterministic in-page probe installed via evaluate
// before a match starts) rather than racing banner visibility.

const { test, expect } = require('@playwright/test');

const CONNECT_BOUND = 10000; // SSE connected snapshot arrives
const CPU_MATCH_BOUND = 25000; // matched→KA(2s)→CHI(1s)→PUN(2s)+skew margins
const PVP_MATCH_BOUND = 40000; // CPU timing + PvP ready handshake (≤8s)
const RECONCILE_BOUND = 15000; // reloaded client reaches a healthy state

const $ = (page, sel) => page.locator(sel);

// Every production console.error / uncaught page error fails the test; the
// suite is specifically hunting the failures that leave NO user-visible trace
// aside from a stuck screen, so any JS-level error is a hard failure.
// ERR_ABORTED is ignored: a hard reload intentionally tears down in-flight
// requests (the SSE stream of the old document) and the browser reports those
// cancellations as console "errors" that are expected, not bugs.
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/net::ERR_ABORTED/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

// Accurately capture every resolved round. The client's renderResult is a
// top-level function declaration → reachable from the window, so we can wrap
// it once the page is up (before any match is started) and record the
// outcome deterministically instead of racing the result banner.
async function installResultProbe(page) {
  await page.evaluate(() => {
    if (window.__kxpProbe) return;
    window.__kxpResults = [];
    const orig = window.renderResult;
    window.renderResult = function (d) {
      try {
        window.__kxpResults.push({ outcome: d.outcome, note: d.yourNote || '', mode: d.mode || '' });
      } catch (e) {}
      if (orig) return orig.apply(this, arguments);
    };
    window.__kxpProbe = true;
  });
}

async function readResults(page) {
  return page.evaluate(() => (window.__kxpResults || []).slice());
}

async function waitForConnected(page) {
  // #online is "…" until the SSE `connected` snapshot arrives.
  await expect($(page, '#online')).toHaveText(/online now/, { timeout: CONNECT_BOUND });
}

async function gotoApp(page) {
  await page.goto('/');
  await waitForConnected(page);
}

// CPU: Play vs CPU is never disabled (works with 0 online).
async function startCPUMatch(page) {
  await $(page, '#btn-cpu').click();
  await expect($(page, '#choose')).toBeVisible({ timeout: CONNECT_BOUND });
  await $(page, '#btn-start').click();
  await expect($(page, '#game')).toBeVisible({ timeout: CPU_MATCH_BOUND });
}

// Online: Play Online is only enabled once another client is seen. The start
// click only queues; the caller must call this on BOTH players before
// rendezvousing on #game (a match is found only once both are queued), so the
// queue-start and match-start assertions are kept separate to avoid a
// deadlock where the first player waits for #game that only the second
// player's queue can produce.
async function startOnlineMatch(page) {
  await expect($(page, '#btn-online')).toBeEnabled({ timeout: PVP_MATCH_BOUND });
  await $(page, '#btn-online').click();
  await expect($(page, '#choose')).toBeVisible({ timeout: CONNECT_BOUND });
  await $(page, '#btn-start').click();
}

async function matchStarted(page) {
  await expect($(page, '#game')).toBeVisible({ timeout: PVP_MATCH_BOUND });
}

// Click the first move the PUN window enables; tolerate a window already past
// (clock skew) — the engine resolves the round either way. A short settle is
// applied so the click lands a beat after the client flips to shoot, avoiding
// a spurious "too early" rejection sitting right on the phase boundary.
async function tryPick(page) {
  const move = $(page, '.move:not([disabled])').first();
  try {
    await move.waitFor({ state: 'attached', timeout: 6000 });
    await page.waitForTimeout(150);
    await move.click({ timeout: 5000 });
  } catch (e) {
    /* window already past (skew); result still arrives */
  }
}

// The match finished when the client has rendered a result (the `result`
// frame arrived and the result screen armed Play Again). The follow-up
// `state idle` frame is NOT a navigation to the lobby — the client state
// machine has no result→stateIdle edge, so the result screen stays until the
// player acts.
async function waitForMatchDone(page, bound) {
  await expect.poll(async () => (await readResults(page)).length, {
    timeout: bound,
    message: 'expected at least one resolved round',
  }).toBeGreaterThan(0);
  await expect($(page, '#btn-again')).toBeVisible({ timeout: bound });
}

test('flow 1: CPU match completes end-to-end within a hard bound with zero errors', async ({ page }) => {
  test.setTimeout(CPU_MATCH_BOUND + CONNECT_BOUND + 15000);
  const errors = watchErrors(page);
  await gotoApp(page);
  await installResultProbe(page);
  await startCPUMatch(page);
  await tryPick(page);
  await waitForMatchDone(page, CPU_MATCH_BOUND);
  expect(errors).toEqual([]);
});

test('flow 2: self-PvP in two isolated contexts resolves consistently on both sides', async ({ browser }) => {
  test.setTimeout(PVP_MATCH_BOUND + CONNECT_BOUND + 30000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errsA = watchErrors(a);
  const errsB = watchErrors(b);
  try {
    await gotoApp(a);
    await gotoApp(b);
    await installResultProbe(a);
    await installResultProbe(b);
    await startOnlineMatch(a);
    await startOnlineMatch(b);
    await matchStarted(a);
    await matchStarted(b);

    // Both sides must reach the shoot state and submit a pick.
    await tryPick(a);
    await tryPick(b);

    // Neither side may be left dead in matched/countdown: each renders a
    // result and returns to the lobby within the bound.
    await waitForMatchDone(a, PVP_MATCH_BOUND);
    await waitForMatchDone(b, PVP_MATCH_BOUND);

    // Consistent result: mirror outcomes, or a shared draw.
    const ra = (await readResults(a))[0];
    const rb = (await readResults(b))[0];
    const consistent =
      (ra.outcome === 'win' && rb.outcome === 'loss') ||
      (ra.outcome === 'loss' && rb.outcome === 'win') ||
      (ra.outcome === 'draw' && rb.outcome === 'draw');
    expect.soft(consistent, `outcomes ${ra.outcome} vs ${rb.outcome}`).toBe(true);
    expect.soft(ra.mode, 'mode is online for a self-PvP match').toBe('online');
    expect.soft(rb.mode, 'mode is online for a self-PvP match').toBe('online');

    expect(errsA).toEqual([]);
    expect(errsB).toEqual([]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('flow 3: reload mid-match reconciles to a healthy state, never stuck on "Waiting for result…"', async ({ page }) => {
  test.setTimeout(CPU_MATCH_BOUND * 2 + CONNECT_BOUND + 20000);
  const errors = watchErrors(page);
  await gotoApp(page);
  await installResultProbe(page);
  await startCPUMatch(page);

  // Let the round begin, then reload mid-match: the tab drops its SSE stream
  // mid-match and reconnects as a fresh anonymous client. The dangerous
  // failure this guards against is a reloaded page that never recovers from
  // the game view (a dead "Waiting for result…" state). The client must
  // reconcile to a healthy lobby via the rejoin snapshot.
  await expect($(page, '#stage')).toBeVisible({ timeout: CPU_MATCH_BOUND });
  await page.reload();

  // The reloaded client reconciles: connected snapshot → lobby, with the game
  // view gone and no "Waiting for result…" text anywhere.
  await waitForConnected(page);
  await expect($(page, '#lobby')).toBeVisible({ timeout: RECONCILE_BOUND });
  await expect($(page, '#game')).toBeHidden();
  await expect($(page, '#count')).not.toHaveText(/Waiting for result/, { timeout: RECONCILE_BOUND });

  // And the reconciled client is fully usable: a fresh player session that
  // can start and complete another match.
  await installResultProbe(page);
  await startCPUMatch(page);
  await tryPick(page);
  await waitForMatchDone(page, CPU_MATCH_BOUND);

  expect(errors).toEqual([]);
});