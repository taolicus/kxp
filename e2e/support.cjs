// The bits every spec in this suite needs, kept in one module once three specs
// wanted them (the registration rule: extract at third use, never carry a
// second copy). Deliberately small — these are conventions, not a framework.
const { expect } = require('@playwright/test');

// Generous, and about the link rather than this machine: the `connected`,
// `matched`, and beat frames all arrive over SSE from the deployed origin.
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

module.exports = { CONNECT_BOUND, watchErrors, gotoLobby, nextPost, lengthBtn };