# Protocol-level production probes (browser-free)

The server needs no browser to be exercised: every endpoint is a `POST` plus one
`GET /events` SSE stream, so a plain Node `fetch` client drives real matches
directly. This is the project's **only** integration path, and the reason the
Playwright suite was withdrawn: these run on hosts that cannot install a browser
at all (the arm64 Android/Termux dev device), so unlike a Chromium-driven suite
they actually execute where the work happens. Landed `tools/t1`–`t8` +
`tools/lib/harness.mjs` + `tools/README.md` (`npm run tall`, `npm run tall -- t5
t6`, `QUICK=1 npm run tall`): link characterization, read-only endpoint
contracts, character round-trip, SSE frame/id/skew contract, a timed CPU match,
mid-match reconnect + reconciliation, the full rejection-code matrix, and
self-paired PvP including the abandoned-handshake case.

→ rationale: [verification.md#why-browser-free-probes](../../development/verification.md#why-browser-free-probes)
