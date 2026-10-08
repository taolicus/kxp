// The game view as a real tab plays it: the full 1-off CPU round, from the
// matched frame that paints the opponent to the result panel that offers Play
// Again, with every phase asserted as painted and any console error failing the
// test.
//
// The stubbed-context harness proves app.js can paint a countdown and ack a
// match; the probes prove the server runs the wire loop. Neither can say a tab
// really acks, really unlocks a move, really posts it, and really renders the
// result -- which is what this file is for. The one thing it deliberately does
// not assert is beat spacing: that is deterministic in
// web/app.countdown.test.cjs and tools/t5, and a wall-clock assertion against
// a production link can only flake.
//
//   npm run e2e -- -g "1-off"
//   BASE_URL=https://your-server.example npm run e2e
//
// Needs Chromium, so it runs on the laptop and not the phone
// (docs/development/environment.md). The match this test starts is a real one;
// /health's activeMatches is the check that the server let it go.
const { test, expect } = require('@playwright/test');

// Generous, and about the link rather than this machine: the `matched` frame
// and every beat arrives over SSE from the deployed origin.
const CONNECT_BOUND = 15000;

// Every console.error and uncaught page error fails the test. A browser suite
// exists to catch what the other gates cannot observe, so any JS-level error is
// a hard failure. ERR_ABORTED is expected, not a bug: a reload tears down the
// old document's in-flight SSE stream and the browser reports the cancellation.
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

// #online reads "…" until the `connected` snapshot lands, so this is the
// lobby-connected signal rather than a navigation one.
async function gotoLobby(page) {
  await page.goto('/');
  await expect(page.locator('#online')).toHaveText(/^\d+ online now$/, {
    timeout: CONNECT_BOUND,
  });
}

// The body of the next POST to `path`, as the server parses it. The waiter is
// armed before the click so the request cannot be missed while it is in flight.
function nextPost(page, path) {
  const seen = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === path
  );
  return async () => JSON.parse((await seen).postData());
}

test('a 1-off CPU match plays end to end in one tab', async ({ page }) => {
  const errors = watchErrors(page);
  await gotoLobby(page);

  await page.locator('#btn-cpu').click();
  await expect(page.locator('#choose')).toBeVisible();
  await page.locator('#btn-start').click();

  // The `matched` frame opens the game view and paints the opponent slot with
  // the CPU's name and `(cpu)` role tag. The "MATCH FOUND" hold itself is too
  // brief to read: the client acks on the next painted frame, so on a fast link
  // the count is already READY when the locator first looks. The readiness
  // proof is below, not here.
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#opp-slot')).toContainText('(cpu)');
  await expect(page.locator('.move[data-move="rock"]')).toBeDisabled();

  // The countdown begins without any test input -- that is the readiness proof.
  // The client posts /ready only after a painted frame, so a headless Chromium
  // that never ran requestAnimationFrame would sit in "MATCH FOUND" until the
  // server cancelled the match, and no beat would ever paint. Reading the beats
  // through to PUN! both proves the handshake opened and that the count paint
  // path runs against real frames.
  const seen = [];
  await expect
    .poll(async () => {
      const t = await page.locator('#count').textContent();
      if (t && t !== '\u200b') seen.push(t);
      return t;
    }, { timeout: CONNECT_BOUND })
    .toBe('PUN!');
  expect(seen).toContain('READY');

  // PUN unlocks the moves and the shot must be fired while the window is open.
  await expect(page.locator('.move[data-move="rock"]')).toBeEnabled();

  const movePost = nextPost(page, '/move');
  await page.locator('.move[data-move="rock"]').click();
  const posted = await movePost();
  expect(posted.move).toBe('rock');
  expect(typeof posted.clickedAt).toBe('number');
  expect(typeof posted.sawPunAt).toBe('number');

  // The authoritative result paints the panel: outcome banner, timing lines,
  // and the Play Again a match that cannot continue offers. The moves lock.
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#banner')).toHaveText(/You win!|You lose|Draw!/);
  await expect(page.locator('#timing')).toBeVisible();
  await expect(page.locator('#btn-again')).toBeVisible();
  await expect(page.locator('.move[data-move="rock"]')).toBeDisabled();

  // The teardown that follows the result must not bounce the tab off the
  // screen it is reading: a client kicked back to the lobby would be a dead end
  // for a player who just saw an outcome land.
  await page.waitForTimeout(2500);
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#btn-again')).toBeVisible();
  await expect(page.locator('#banner')).toHaveText(/You win!|You lose|Draw!/);

  expect(errors).toEqual([]);
});