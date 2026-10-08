# Arcade mode: 1 retry every N floors cleared (configurable)

**Status:** Unconfirmed — next action is to specify mechanics and constraints.

## Summary
Add a retry mechanic to arcade mode: grant 1 retry every N floors cleared. On a loss, if the player has cleared >= N floors since the last retry (or since start), they may retry instead of ending the run. The number of floors per retry must be configurable so "easy" (1 per 2 floors) and "hard" (1 per 3 floors) can be supported.

## Hypothesis
Arcade runs become less punishing without removing stakes by awarding retries at fixed floor intervals; making N configurable per difficulty keeps it server-authoritative.

## Questions to resolve
1. **Counting.** What counts as "cleared a floor"? Win on floor? Does draw count? Reset after retry and at run start?
2. **Balance.** Earn 1 per N (non-negative balance) or bank (cleared 4, N=2 -> 2)? Or strict "since last retry >=N" grants exactly 1?
3. **On loss.** When eligible, grant retry option on loss instead of end. Is it consumed immediately? Preserve score/streaks/timers or reset state?
4. **Config.** Where lives `floorsPerRetry` (mode/difficulty)? Must be server-side only. Wire changes additive if exposed.
5. **Edges.** N>=1. N=1. Exactly N. Multiple losses. Retry after retry. What if floor count not tracked yet?

## Acceptance criteria
- Configurable `floorsPerRetry` (integer >=1), documented defaults (2 easy, 3 hard).
- Server-side eligibility on loss in arcade; client cannot grant.
- Explicit consumption and window reset defined.
- Deterministic tests with boundaries and negative cases.
- No over-correction. Additive wire changes only if new events needed.

## Evidence to graduate
- Task file in `docs/tasks/open/` with affected files, build steps, verification.
- Feature docs updated stating invariant and rejected alternatives.
- Tests failing before change, passing after, in same commit.
- Verified per rules; host limits stated if unverifiable.

