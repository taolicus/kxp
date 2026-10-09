# A failed request gives no visible feedback

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — when a POST fails, the pending button is re-armed and nothing
else happens. Silent paths include `/challenge` and `/queue` for any status
other than 409 (`app.js:1404-1407`, `1420-1425`), Play Again's `/cpu`
(`app.js:1547-1549`), the tower's Fight button (`app.js:1572-1574`), and every
network-level failure, where `post()` returns null (`app.js:919-921`). A 409
is the only refusal that speaks (`setNotice('You are already in a match.')`).
The player taps, the button flickers through pending, and nothing appears to
happen.

**Where it shows** — any mode's start button, Play Again, tower Fight, challenge
create — whenever the network or the server refuses.

**Working hypothesis** — each call site grew its own `clearPending()` and the
generic case was left to recover silently; `#notice` already exists as the
voice for refusals (`setNotice`, `app.js:981`).

**Questions to resolve**

1. Copy for a generic failure, and whether HTTP status should differentiate
   (client refusal vs server error vs offline).
2. Is `#notice` — rendered above the views (`index.html:22`) — the right
   surface on the choose, queue and game screens, or does it belong per-view?
3. Should the failsafe re-arm (`app.js:932-940`) also speak, or stay silent?

**Proves the cause** — a decision on copy and surface; the client harness can
stub fetch, so the behaviour is testable once chosen
(`web/appHarness.cjs`).

**Prospective fix (not scheduled)** — one `noticeFrom(res)` helper used by
every caller that already handles `!res.ok`.
