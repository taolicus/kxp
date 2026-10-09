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

## Landed

The `locked` gap was real, and it is the one the fix is for.

**What changed.** `armStallWatchdog`'s fire check is now
`!GAME_STATES.includes(state)` rather than the two-state
`state !== 'shoot' && state !== 'countdown'`, and `enter.countdown` no longer
clears the timer. `locked` is where a round actually sits when the result frame
is lost, so the old check declined in exactly the case the watchdog exists for.
`countdown` is live (`GAME_STATES`) and a `snapshot:countdown` can route an armed
round back into it, so it must not disarm; the disarm set is now the entries
that leave a round — `lobby`, `waiting`, `matched`, `result`, `ladder`.

**How it was verified.** Six watchdog tests were added to
`web/app.reconnect.test.cjs`, which already owns the reconciler's arrival and
now pins its departure: the realistic `locked` path driven through `enter.shoot`
and the local lock timer; the fire check in each of `countdown`, `shoot`,
`locked`; the 6000 ms boundary from both sides; a re-arm resetting the single
timer rather than stacking a second; the disarm set shown to leave no timer for
a later round; and `countdown` kept armed across a `snapshot:countdown`.
`web/*.test.cjs` 157/157 and `npm run unit` 186/186.

**Negative proof.** Against the pre-change `app.js`, three of the new tests fail:
`locked` on the fire check (twice, once each test) and countdown-survival on the
`enter.countdown` disarm. Each criterion was then mutated on the fixed file and
reverted byte-identical (sha256 `fba06144…`): removing the `enter.shoot`
invocation fails two tests; re-adding `clearTimeout(stallTimer)` to
`enter.countdown` fails countdown-survival; dropping it from `enter.result`
fails the disarm test; changing the budget to 5000 fails the boundary test;
reverting the fire check to the two-state form fails the `locked` and
all-live-states tests.

**Not verified here.** Whether a round-resolve frame is actually lost on a real
radio is unmeasured — this slice settles the code question only. The host is the
phone (arm64 Android): `go test -race` cannot run, but no Go and no shared server
state is touched, so it does not apply; rendering and console errors have no
coverage on either host and none is claimed.
