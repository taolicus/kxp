# Core-gameplay e2e (withdrawn)

A Playwright suite that drove the real browser against the **deployed server**
to surface game-breaking connectivity failures that resist unit testing. It
landed as `e2e/gameplay.spec.js` + `playwright.config.cjs` + `npm run e2e`, and
was then **removed** rather than kept: the only host this project runs on is
arm64 Android/Termux, where Chromium cannot be installed, so the suite never
actually ran and could not have caught a regression. Keeping an unrunnable suite
is worse than not having it — it advertises coverage that does not exist, and
every future reader has to re-derive that fact. The coverage it was scoped for is
served by [browser-free-probes.md](browser-free-probes.md), which does run here;
what is genuinely lost is in-browser rendering, CSS and console-error checking,
now recorded as an explicit gap rather than an absent test.

Withdrawn in `31a0384` — *Testing: withdraw the Playwright e2e suite, and say so
instead of pretending*.
