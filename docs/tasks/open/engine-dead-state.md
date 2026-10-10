---
phase: 3
depends-on: []
gated-on: []
---

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
