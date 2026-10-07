---
phase: 2
depends-on: []
gated-on: []
---

# t5 cannot pass, and never could since the series build

`npm run tall` reports `t5 · CPU match end-to-end` FAIL. t1–t4, t6–t8 pass. The
failure is not the server: t5's own output shows a perfect match, and its final
line is `ASSERT: Assignment to constant variable`, which is a thrown JS error
from the probe's own script, not a verdict about frames.

Two defects, both introduced by `0979b20` ("Game mode: play a CPU match as a
first-to-3 series") when it turned t5 from a one-round check into a series:

1. `tools/t5-cpu-match.mjs:165` is `cursor = sse.marked(result)` but `cursor` is
   the `const` from line 58 — so the assignment throws, and t5 can never pass
   and never even reach its series loop. This has been true of every tall run
   since 2026-10-05; nobody noticed, which is exactly what a verdict that never
   fires trains you to do.
2. `:132` slices the frame-order check from `sse.since(0)`, which includes the
   connection's `connected` and `online` frames. The check asserts exactly
   `matched → countdown ×3 → shoot → result`, so it fails with a real mismatch
   *before* the throw above — the trace a reader sees is
   `(connected → online → matched → countdown ×3 → shoot → result)` which is the
   wire behaving correctly and the fixture frame being wider than the expected
   list.

## What the fix is

- Make `cursor` a `let` (line 58), so line 165's reassignment is legal.
- Slice `round1` from the /cpu mark rather than from stream start:
  `sse.since(cursor).slice(0, sse.marked(result))` — `cursor` is marked after
  `connected` and before `POST /cpu`, which is exactly the `matched → countdown
  ×3 → shoot → result` the check expects.
- Run `npm run tall`; t5 must pass, and the series loop (`rounds ≤ 9`) must now
  actually execute for a first-to-3 CPU match.

## Verified while specifying

`git blame` on both lines lands on `0979b20`; t5 imports only
`tools/lib/harness.mjs` (its `import` line is at the top), so no client change
can affect it. `npm run tall` run 2026-10-07: 7/8 pass, t5 FAIL
(`Assignment to constant variable`) against a live server whose
`/health` reports `build d60f8fa` = local `HEAD`.