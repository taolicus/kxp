---
priority: 7
phase: 3
depends-on: [game-mode-architecture]
gated-on: []
---

# One owner for match termination

The engine ends the match; the hub only wires. Today `match.run()` advances the
phase and records `abandon`/`requeued`, then `Hub.finishMatch` decides *per side*
whether to emit a teardown frame by re-checking `s.match == m` under `h.mu`.
That re-check exists only because the two lifecycles overlap (a re-pair can
install a newer match before the old one's `finish` runs), and it is what the
stale-teardown bug class reduces to. Making the engine the single writer — it
produces the termination description (per-side `requeued`, `abandonReason`,
terminal frames) and the hub just applies it to concrete clients — collapses two
sources of truth into one and retires the conditional-teardown branch.

## Shape

`run()` hands its `finish` callback a single termination record describing the
match instance, so the hub no longer needs to re-derive which frames are still
valid. `drainMoves()` stays unconditional and in the hub — that one is the
client's own channel, not the engine's view.

## Not urgent and deliberately not scheduled

The current path is correct and pinned by `finish_test.go`; this is a structural
refactor of the finish seam, and the Phase 3 work that actually pays off — series
mode (see [game-mode-architecture](game-mode-architecture.md)) — has to add
per-round termination *on top of* whatever shape this takes. Do it in that
order, not before, or it is paid for twice.

Unscheduled by priority, not by lifecycle: it is a task, so it does not belong in
`docs/issues/` — `workflow.md` makes priority metadata, not a directory.
