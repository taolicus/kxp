// Core-gameplay e2e: three deliberately narrow flows that drive a real browser
// against the DEPLOYED (production) server over real SSE, surfaced by
// Playwright on any Chromium-capable host. The suite never boots the app
// locally and needs only Node >= 20 and Playwright's Chromium; the target is
// chosen by the required BASE_URL (see playwright.config.cjs).
//
// The flows are scoped by the roadmap (item 8) to the *game-breaking
// connectivity failures that resist unit testing*:
//
//   1. a CPU match completes end-to-end within a hard bound, with zero
//      console/page errors;
//   2. a PvP match produces a result on both sides, neither left dead in
//      matched/countdown (the asymmetric-SSE class). A first instance queues
//      and waits a short bound (REAL_USER_PAIR_BOUND) for a real opponent — a
//      real pairing is valid and the more valuable case, so it is run as-is;
//      only if none appears is a second instance launched so the two queue
//      against each other;
//   3. a reload mid-match reconciles to a healthy state, never stuck on a dead
//      "Waiting for result…" view.
//
// No button/stat/styling assertions, per scope.
//
// Runtime notes
// -------------
// The server pairs its online queue strictly FIFO with no private matching, so
// on a live server a stranger queueing inside the pair window can take one of
// our slots. Flow 2 therefore proves self-pairing from the result frames
// (each side's opponentCharacter must be the other's youCharacter) and asserts
// strict win↔loss/draw↔draw consistency only when self-pairing is proven;
// otherwise it still asserts the hard completion invariants (result reached,
// mode online, zero console errors) — which is the meaningful production check.
//
// A finished match leaves the client on the result screen (the machine has no
// result→stateIdle edge; "Play Again / Change mode" waits for the player), so
// the suite keys completion off `#btn-again` arming after `renderResult`
// (captured through a deterministic in-page probe installed via evaluate
// before a match starts) rather than racing banner visibility.

const { test, expect } = require('@playwright/test');

// BASE_URL is guaranteed present and valid here: playwright.config.cjs throws
// at load if it's missing or malformed, so the suite cannot start otherwise.
const baseURL = process.env.BASE_URL;

// Bounds are about the internet, not hardware: generous delivery margins for
// a real network, deliberately not tuned to any one device.
const CONNECT_BOUND = 15000; // SSE connected snapshot arrives
const CPU_MATCH_BOUND = 30000; // matched→KA(2s)→CHI(1s)→PUN(2s)+delivery margins
const PVP_MATCH_BOUND = 50000; // CPU timing + PvP ready handshake (≤8s)
const RECONCILE_BOUND = 15000; // reloaded client reaches a healthy state
const REAL_USER_PAIR_BOUND = 5000; // how long flow 2 waits for a real opponent

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
// outcome deterministically instead of racing the result banner. We also
// record each side's character so flow 2 can prove self-pairing afterward.
async function installResultProbe(page) {
  await page.evaluate(() => {
    if (window.__kxpProbe) return;
    window.__kxpResults = [];
    const orig = window.renderResult;
    window.renderResult = function (d) {
      try {
        window.__kxpResults.push({
          outcome: d.outcome,
          note: d.yourNote || '',
          mode: d.mode || '',
          you: d.youCharacter || '',
          opp: d.opponentCharacter || '',
        });
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

// CPU: Play vs CPU is never disabled (works with any online count).
async function startCPUMatch(page) {
  await $(page, '#btn-cpu').click();
  await expect($(page, '#choose')).toBeVisible({ timeout: CONNECT_BOUND });
  await $(page, '#btn-start').click();
  await expect($(page, '#game')).toBeVisible({ timeout: CPU_MATCH_BOUND });
}

// Online: Play Online is only enabled once another client is online, so flow
// 2 must connect its second context (left in the lobby) before the first can
// queue. charId (optional) picks a distinct fighter so self-pairing can be
// proven from opponentCharacter later. This queues only; the caller decides
// when to rendezvous on #game.
async function startOnlineMatch(page, charId) {
  await expect($(page, '#btn-online')).toBeEnabled({ timeout: PVP_MATCH_BOUND });
  await $(page, '#btn-online').click();
  await expect($(page, '#choose')).toBeVisible({ timeout: CONNECT_BOUND });
  if (charId) await $(page, `.fighter[data-char="${charId}"]`).click();
  await $(page, '#btn-start').click();
}

// Click the first move the PUN window enables; tolerate a window already past
// (clock skew / delivery lag) — the engine resolves the round either way.
// A short settle is applied so the click lands a beat after the client flips
// to shoot, avoiding a spurious "too early" rejection on the phase boundary.
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

test('flow 2: PvP resolves on both sides — real opponent first, self-pair fallback, never dead in matched/countdown', async ({ browser }) => {
  test.setTimeout(PVP_MATCH_BOUND * 3 + CONNECT_BOUND * 2 + 30000);
  // Manual contexts do NOT inherit config use.baseURL, so pass it explicitly.
  const ctxA = await browser.newContext({ baseURL });
  const ctxB = await browser.newContext({ baseURL });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errsA = watchErrors(a);
  const errsB = watchErrors(b);
  try {
    // B connects too but stays in the lobby: A's #btn-online only enables
    // once another client is online, even with zero real traffic.
    await gotoApp(a);
    await gotoApp(b);
    await installResultProbe(a);
    await installResultProbe(b);

    // First instance queues alone and waits a short bound for a real
    // opponent; A and B get distinct fighters so self-pairing can be proven
    // from opponentCharacter afterward.
    await startOnlineMatch(a, 'dragon');
    let realOpponent = false;
    try {
      await $(a, '#game').waitFor({ state: 'visible', timeout: REAL_USER_PAIR_BOUND });
      realOpponent = true;
    } catch (e) {
      // No real user joined within the bound → A is still queueing.
    }

    if (!realOpponent) {
      // No real opponent appeared: launch the second instance to queue
      // against A. FIFO pairing joins the queue head (A) with B.
      await startOnlineMatch(b, 'sombrero');

      // Both must reach the game view. A stranger that grabbed A exactly at
      // the boundary leaves B waiting in queue — that is the real-opponent
      // case, so neither side may be blocked on the other's slot.
      const [aStarted, bStarted] = await Promise.all([
        $(a, '#game').waitFor({ state: 'visible', timeout: PVP_MATCH_BOUND }).then(() => true).catch(() => false),
        $(b, '#game').waitFor({ state: 'visible', timeout: PVP_MATCH_BOUND }).then(() => true).catch(() => false),
      ]);
      if (!aStarted) {
        // Both timed out: the FIFO pair never formed. Hard fail — this is
        // exactly the "left dead in queue" class flow 2 exists to catch.
        expect(aStarted, 'A must reach the game view').toBe(true);
      }
      if (!bStarted) {
        // A is in-game, B never matched → a stranger took A at the boundary:
        // degrades to the real-opponent path for A (B stays clean in queue).
        await tryPick(a);
        await waitForMatchDone(a, PVP_MATCH_BOUND);
        const ra = (await readResults(a))[0];
        expect.soft(ra.mode, 'mode is online for a PvP match').toBe('online');
        expect(errsB).toEqual([]);
      } else {
        await tryPick(a);
        await tryPick(b);
        await waitForMatchDone(a, PVP_MATCH_BOUND);
        await waitForMatchDone(b, PVP_MATCH_BOUND);

        const ra = (await readResults(a))[0];
        const rb = (await readResults(b))[0];
        expect.soft(ra.mode, 'mode is online for a PvP match').toBe('online');
        expect.soft(rb.mode, 'mode is online for a PvP match').toBe('online');

        // Prove self-pairing: each side's opponent must be the other's
        // character. Only then is a strict mirror/draw outcome meaningful —
        // a stranger interleaving in the pair window breaks the symmetry by
        // design and is handled via mode/completion invariants alone.
        const selfPaired = !!ra.you && !!rb.you && ra.opp === rb.you && rb.opp === ra.you;
        if (selfPaired) {
          const consistent =
            (ra.outcome === 'win' && rb.outcome === 'loss') ||
            (ra.outcome === 'loss' && rb.outcome === 'win') ||
            (ra.outcome === 'draw' && rb.outcome === 'draw');
          expect.soft(consistent, `self-paired outcomes ${ra.outcome} vs ${rb.outcome}`).toBe(true);
        }

        expect(errsB).toEqual([]);
      }
    } else {
      // A real user took a slot before our self-pair: run with it, the more
      // valuable case. B stays idle in the lobby and must stay clean.
      await tryPick(a);
      await waitForMatchDone(a, PVP_MATCH_BOUND);
      const ra = (await readResults(a))[0];
      expect.soft(ra.mode, 'mode is online for a PvP match').toBe('online');
      expect(errsB).toEqual([]);
    }

    expect(errsA).toEqual([]);
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