---
phase: 2
depends-on: []
gated-on: []
---

# Pin the client stall watchdog

`web/app.reconnect.test.cjs` asserts where a reconnected client **lands**. Nothing
asserts whether it reconnects at all. `armStallWatchdog()` (`web/app.js:23`) is
that trigger, and it is untested — so the recovery path has a tested destination
and an unverified departure.

## Required context

[architecture.md](../../features/architecture.md) § SSE lifecycle (watchdog and
snapshot) and § Timing model (clock skew). The code is `web/app.js:23-32` (the
watchdog), `:35` (`GAME_STATES`), `:412-448` (`enter.shoot`, `enter.locked`), and
the enter handlers at `:358, :366, :375, :388, :450`.

## What the source shows

Confirmed by reading, and worth stating exactly because it is the whole slice:

- armed in exactly one place — `enter.shoot` (`web/app.js:415`), on a 6000 ms
  budget;
- disarmed by `enter.lobby`, `enter.waiting`, `enter.matched`, `enter.countdown`
  and `enter.result`;
- `enter.locked` neither disarms nor arms;
- the callback declines unless `state` is `shoot` or `countdown`.

`GAME_STATES` is `['countdown', 'shoot', 'locked']`, so the codebase already
treats `locked` as a live round. A client that reaches `locked` and then stalls —
the round-resolve frame lost on a weak link — has a live timer that will not fire
for it, and no error surfaced. That is [silent-stuck](../../issues/silent-stuck.md)
almost verbatim, and it is the one state the watchdog's own comment ("armed while
a game view is live") does not hold for.

## What is not known

Whether a round can actually be stranded in `locked` on a real radio. The
asymmetry above is confirmed in the code; its reachability is not, and on a weak
link it plausibly is not. So the slice is written to settle the question rather
than assume it — and the `locked` case is where the evidence comes from.

## Acceptance criteria

1. Armed and still in `countdown` or `shoot` when the budget expires: the stream is
   closed, `connect()` runs, and a `stalled` beacon is reported.
2. Disarmed states (`lobby`, `waiting`, `matched`, `result`) never tear the stream
   down, however far the clock advances.
3. `locked`: pinned in whichever direction the code behaves. If the gap is real, the
   test fails against the current fire check, the cause is confirmed, and the fix
   follows the evidence — make the fire check and the disarm set agree with
   `GAME_STATES` rather than re-deriving a second list. If it turns out reachable
   through some other path, that path is what gets pinned instead.
4. Budget bounds in both directions: not before 6000 ms, and re-arming resets the
   single timer rather than stacking a second one. A watchdog that fires early
   throws a player out of a healthy match, which is worse than not firing at all.
5. Each case proven by mutation, as the reconciler slice was: break the
   invocation, the disarm set, the budget, the fire check, and confirm a test fails
   each time, reverting `app.js` byte-identical.

## Notes

- This is a task and not an [issue](../../issues/) because the mechanism is traced
  to specific lines; [docs/register.md](../../register.md) holds that a bug whose
  mechanism you traced is a fix, not a symptom. Do not re-file it there.
- No new harness is needed. `web/appHarness.cjs` already supplies the clock, the
  hand-fired timer queue and the `EventSource` stub, which is the whole reason this
  slice is cheap enough to take next.
- Unverifiable on this host, and worth recording here when the slice lands
  (along with the report, not the commit message): whether a
  round-resolve frame is actually lost on a real radio. Criterion 3 settles the
  code question, not the radio one.