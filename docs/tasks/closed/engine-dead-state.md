# Remove dead state from the engine

Four identifiers in `round.go` are defined or written but never read. None is a
defect: each is residue from a shape the engine passed through, and each is a
piece of state a reader has to rule out as meaningful. Removing them is the
whole point, so there is nothing to design.

## The identifiers (lines as of the survey; names are the contract)

- `match.humanMask` — a method with no caller anywhere in the repo.
  `allHumanFreshLocked` computes the same set inline. Delete it.
- `match.abandonSide` — assigned on the opponent-left paths and never read; the
  side is already in the caller's context at both writes. Delete the field and
  the two assignments.
- `abandonNone` — the zero value of the `abandon*` set, named only by a doc
  comment and never compared. Zero is already the natural default; delete the
  constant and keep the comment's meaning on `abandon`.
- `match.id` — never read by production code (the `matched`/`state` frames carry
  no match id); the only reader is an error string in `finish_test.go`. Because
  the field is the sole consumer of `makeMatch`/`newMatch`'s `id` parameter, the
  three production `newID(4)` calls that feed it (in `tryMatch`, the CPU
  handler, and `handleJoin`) are wasted `crypto/rand` work.

## Constraints

- **Pure deletion.** No phase, timing, or wire behaviour changes.
- **The engine boundary holds.** `round.go` keeps knowing nothing about `Hub`,
  `Client`, or SSE.
- `match.id` is the churny one: `makeMatch`/`newMatch` lose their `id`
  parameter, and roughly fifty test call sites pass a literal label
  (`makeMatch("m1", …)`) that goes with it. **Do it as its own commit inside
  this task** — it is mechanical but wide, and separating it keeps the three
  one-line removals independently revertable.
- Tests are the consumers for some of this, so they change in the same commit as
  the code they pin (`finish_test.go` must stop naming `next.id`).

## Acceptance

`gofmt -l .` empty, `go vet ./...` clean, `go test ./...` green, and a repo-wide
grep for `humanMask`, `abandonSide`, `abandonNone`, and `match`'s `.id` finds no
reference.

## Unscheduled, not low-priority

Nothing forces this: the code is correct, just carrying state a reader must
evaluate. It is a task because the next action is fully specified and needs no
conversation; it is not scheduled because the engine has not needed touching.

## Landed

- The three one-line removals (`humanMask`, `abandonSide`, `abandonNone`) landed
  first, as their own commit so they stay independently revertable from the wide
  one. The abandon values keep their numbers — `iota + 1` over zero, so the zero
  value of a match's `abandon` field is still "never cancelled" and
  `abandonReason()` still returns the same three labels.
- `match.id` landed second: the field, `newMatch`/`makeMatch`'s `id` parameter,
  and roughly sixty call sites (three production `newID(4)` feeds in `tryMatch`,
  `handleCPU`, `handleJoin`; the rest literal labels in tests), plus the one
  reader the field had, an error string in `finish_test.go` that now names the
  new match instead of its id. The accusatory label in every struct-literal
  test match (`&match{id: "…"}`) went with it. `architecture.md` now quotes
  `newMatch(roundsTarget)`.
- **Verified:** grep for `humanMask`, `abandonSide`, `abandonNone` and the
  removed field is empty (the negative direction — each was found before its
  own commit); `gofmt -l .` empty; `go vet ./...` clean; `go test -count=1
  ./...` ok 197.620s. The readiness/finish/queue/series round of the focused
  suite also ran green after the first commit.
- A `newID(4)` call remains, in `Client.beginConn` — that one mints the
  connection id, not a match id, so `newID` stays live.
