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

## Landed

Both defects fixed. `cursor` is now `let`, and the round-one frame order is
sliced from the `/cpu` mark through the result frame:

```js
const round1 = sse.since(cursor).slice(0, sse.marked(result) - cursor).map((f) => f.type);
```

The literal expression this task specified, `sse.since(cursor).slice(0, sse.marked(result))`,
needs the `- cursor`: `marked()` returns an absolute index while `since(cursor)`
has already dropped `cursor` frames, so the end index has to be rebased. On the
happy path — no round-two `countdown` on the wire yet — the two agree, so the
wrong form would have looked fixed; with one already received it over-includes
and fails the same check, which is exactly the race the comment above the line
names. The offset form holds the stated intent: `matched → countdown ×3 → shoot
→ result` and nothing after the result.

Negative proof, phone against the deployed origin (`/health` `build 003cbfc` =
local `HEAD`): before the change `npm run t5` FAILed with both symptoms in one
run — `FAIL frame order matched → countdown ×3 → shoot → result` on
`connected → online → matched → countdown ×3 → shoot → result`, then
`ASSERT: Assignment to constant variable.`; after it, `npm run t5` passes 47/47
and the series loop executes (rounds 2–5 for a first-to-3 CPU match).

The probe's own series cap was folded into this fix: with the draw-replay tail
as measured in `bd499f4` (>8 rounds 13.5%, 16 ≈ 0.015%), the original
`rounds <= 9` guard would make t5 flake roughly once a dozen tall runs now that
the loop actually executes — failing at the guard, not at a defect. t5's cap is
the sibling spec's 16, for the same reason, and it remains a guard rather than a
contract.

Gates on this host (phone): `npm run tall` 8/8, `npm run unit` 180/180,
`npm run links` 0 broken, `gofmt -l .` clean, `go vet ./...` clean,
`go test ./...` ok (199.7s). `go test -race` still cannot run on `android/arm64`; it
was never a candidate surface here, since the change is `tools/` only and no Go
gate could be the failing one. Rendering is not involved.
