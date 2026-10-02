# Absent-on-return restart after a long idle (game-screen hiccup)

**Symptom** — a player leaves the game screen open, goes about other business
for a while, comes back, and hits Play Again (or otherwise restarts) — and the
game screen hiccups (stale frames, a bad transition, or a match that starts out
of step) instead of playing cleanly.

**Where it shows** — the browser tab kept alive in the background across a long
idle, then a restart action.

**Working hypothesis** — the client built a bunch of state that expires across
an idle gap: the planned countdown schedule (announced `shootAt`) and the
clock-skew estimate can be long stale by the time the player returns, and any
in-flight timers / SSE frames from before the idle are inconsistent with the
live match. A restart immediately after that resumes on the stale local state
rather than a fresh snapshot. Whether it's purely stale-client-state vs. a
server-side mismatch is unproven.

**Proves the cause** — a repro that logs the client state + frames seen vs. the
server snapshot received on the restarting action, or a forced fresh `connected`
snapshot on restart showing the hiccup disappears.

**Prospective fix (not scheduled)** — force a clean client reset (re-fetch the
snapshot, drop the stale plan and skew) whenever a restart action happens after
a long idle, or cap the plan/skew lifetime client-side so a stale schedule is
treated as expired.
