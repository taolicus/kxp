# Browser-level lobby e2e (Playwright re-added)

The Playwright harness came back now that a second host can run it. The laptop
installs Chromium; the phone cannot, which is the whole reason the harness was
withdrawn in the first place
([core-gameplay-e2e-withdrawn.md](core-gameplay-e2e-withdrawn.md)). The premise
of that decision — one host, and it could not run a browser suite — stopped
holding when the MacBook Pro joined
([device-aware-workflow.md](../../development/device-aware-workflow.md)).

What landed, in two commits:

- `3918ffd` — the harness: `@playwright/test` as the one dependency,
  `npm run e2e`, `playwright.config.mjs`, and the artifact entries in
  `.gitignore`. The config imports `tools/lib/base.mjs` rather than resolving
  the origin itself, so BASE_URL and `tools/.base-url` mean the same thing to
  every suite in the tree.
- the spec commit — `f44b4a4` — `e2e/lobby.spec.js`, three tests that are ports
  of cases in [web/app.lobby.test.cjs](../../../web/app.lobby.test.cjs): the
  lobby paints the connected snapshot and lights its own default, a CPU match
  starts at the length the lobby is showing (the POST body read on the wire),
  and the chosen mode is the one a reload starts with (real localStorage across
  a real reload). Each fails on any console or page error, which no
  stubbed-context test and no probe can observe.

`npm run e2e` now sits in the run list with the rest of the gates, scoped by
host: "needs origin + Chromium, so the laptop only" is the door a phone leaves
open for a laptop-made rendering claim
([verification.md](../../development/verification.md) and
[environment.md](../../development/environment.md) both record the split).

## Why it ran green against the deployed server before it was committed

Verification is what this suite is for. Run on the MacBook 2026-10-08 against
https://kxp.tao.cl: `npm run e2e` → **3/3 passed (14.7s)**. A negative run —
one expectation deliberately wrong — **failed loudly** rather than passing
silently, so the assertions read the real POST rather than a value that happens
to be true. `/health` reported `activeMatches: 0` after the run, so the CPU
matches the tests started were let go by the server, not stranded.

## What the suite does not cover

Styling and layout are asserted nowhere on either host, and these three specs
cover the lobby only — the game view, the result screen and the queue have no
browser-level coverage yet. The phone cannot run any of this: on that host a
rendering claim is still hand-checked, and must say so.