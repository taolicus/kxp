// The lobby as a player's tab actually runs it: the connected snapshot the
// lobby renders, and the length + draw rule a match is asked for.
//
// These are ports of three cases in web/app.lobby.test.cjs, kept as the narrow
// overlap between what already exists and what only a browser can see. The
// harness tests drive the real app.js against a stubbed context, so they cannot
// notice markup the client did not build, a render that never lands, or a
// console error; the probes speak the real protocol but have no DOM at all.
// Everything else the lobby does is already covered by one of those two, so
// this file asserts the three things that neither can: the online count as it
// is painted, the button the client lights itself, and the POST that leaves the
// browser — observed on the wire and read back as the server receives it.
//
// No styling or pixel assertions: what a stubbed context and a probe both miss
// is the render and the request, not a shade of a colour.
//
//   npm run e2e                                   # origin from tools/.base-url
//   BASE_URL=https://your-server.example npm run e2e
//
// Needs Chromium, so it runs on the laptop and not on the phone
// (docs/development/environment.md). Tests 2 and 3 start a real CPU match and
// stop there — the tab goes away with the context, and /health's activeMatches
// is the check that the server let it go.
const { test, expect } = require('@playwright/test');

// Generous, and about the link rather than this machine: the connected
// snapshot arrives over SSE from the deployed origin.
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

const lengthBtn = (page, rounds) =>
  page.locator(`#cpu-length .seg-btn[data-rounds="${rounds}"]`);

test('the lobby paints the connected snapshot and the default the client chose', async ({ page }) => {
  const errors = watchErrors(page);
  await gotoLobby(page);

  // The count is rendered, not merely fetched: a number followed by the copy
  // the lobby shows, with the markup's "…" gone.
  await expect(page.locator('#lobby')).toBeVisible();
  await expect(page.locator('#online')).toHaveText(/^\d+ online now$/);

  // The markup paints no option as selected — the client decides, once the
  // roster that frames the lobby has arrived — so the first option being lit
  // is the client's own default, and a control that ships unlit is caught here
  // rather than posting whatever the server's fallback happens to be.
  await expect(lengthBtn(page, 1)).toHaveClass(/selected/);
  await expect(lengthBtn(page, 3)).not.toHaveClass(/selected/);

  expect(errors).toEqual([]);
});

test('a CPU match starts at the length the lobby is showing', async ({ page }) => {
  const errors = watchErrors(page);
  await gotoLobby(page);

  await expect(lengthBtn(page, 1)).toHaveClass(/selected/);
  const body = nextPost(page, '/cpu');
  await page.locator('#btn-cpu').click();
  await expect(page.locator('#choose')).toBeVisible();
  await page.locator('#btn-start').click();

  // The default is one round and the rule that ends it: the choice is the
  // client's, the numbers come off the control's own button, and the pair that
  // leaves the browser is what the server is asked to build.
  const posted = await body();
  expect(posted.roundsTarget).toBe(1);
  expect(posted.drawEnds).toBe(true);

  expect(errors).toEqual([]);
});

test('the chosen mode is the one a reload starts with', async ({ page }) => {
  const errors = watchErrors(page);
  await gotoLobby(page);

  // The choice is a short-lived click but a long-lived intention: it is stored
  // as (length, rule), and a reload must find the same option lit — the player
  // who picked first-to-three did not change their mind by reloading.
  await lengthBtn(page, 3).click();
  await expect(lengthBtn(page, 3)).toHaveClass(/selected/);
  await expect(lengthBtn(page, 1)).not.toHaveClass(/selected/);

  await page.reload();
  await expect(page.locator('#online')).toHaveText(/^\d+ online now$/, {
    timeout: CONNECT_BOUND,
  });
  await expect(lengthBtn(page, 3)).toHaveClass(/selected/);
  await expect(lengthBtn(page, 1)).not.toHaveClass(/selected/);

  // And it is what gets played, not just what gets shown: the restored pair is
  // posted in full, rule included.
  const body = nextPost(page, '/cpu');
  await page.locator('#btn-cpu').click();
  await expect(page.locator('#choose')).toBeVisible();
  await page.locator('#btn-start').click();

  const posted = await body();
  expect(posted.roundsTarget).toBe(3);
  expect(posted.drawEnds).toBe(false);

  expect(errors).toEqual([]);
});
