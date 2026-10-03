---
phase: 3
depends-on: [match-termination-owner]
gated-on: []
---

# Split `server.go` into per-concern files

`server.go` is 1001 lines holding the whole HTTP and hub layer: the `Client`
type, the `Hub` type and its registry, the SSE event stream, matchmaking, match
teardown, and eleven route handlers. It is the largest file in the tree and the
only one where unrelated concerns share a namespace by accident rather than by
design. This is the seam map, so nobody has to re-derive it.

## Why one task and not five

The concern is one — how the hub's HTTP layer is laid out in files — and the work
is a sequence of moves inside it. Five task files would be five homes for one
decision, which is what [docs/register.md](../../register.md) exists to prevent.
Each move is its own commit, so the slice discipline in `AGENTS.md` still applies
per move; the register records the build, not the step count.

## Seam map

Line numbers are as of `54a1801` and will drift; the declaration names are the
contract.

| new file | takes |
| --- | --- |
| `client.go` | `Client`, `newClient`, `sendEv`, `sendEvRaw`, `newID`, `beginConn`, `recordFrame`, `frameJournal`, `drainMoves` |
| `hub.go` | `Hub`, `NewHub`, `routes`, `Shutdown`, `getOrCreate`, `client`, `removeClient` |
| `sse.go` | `handleEvents` (98 lines, the largest unit), `endConn`, `frameType`, `encodeEv`, `logDroppedEvent`, `sseWriteDeadline`, the var block at `:53` |
| `matchmaking.go` | `side`, `tryMatch`, `makeMatch`, `startMatchLocked`, `finishMatch`, `dequeueLocked`, `snapshot`, `othersOnlineLocked`, `broadcastOnline` |
| `handlers.go` | `statusWriter`/`accessLog`, `handlerError`, `decode`, the eleven `handle*` route handlers, `clip` |

Two calls are judgement, not mechanics. `snapshot` and `broadcastOnline` are hub
state reporting rather than matchmaking, and could sit in either; pick one and say
why in the commit body. `maxBodyBytes` is a request limit, not an SSE detail, so it
does not belong to `sse.go` on the strength of where it happens to sit.

## Constraints

- **Pure move.** Same package, so no visibility changes are needed or wanted: the
  declarations are package-private and stay that way. No renames, no signature
  changes, no logic edits, no comment rewrites beyond what a move requires.
- **`-race` cannot run on this host** (`environment.md`), so verification of a
  move is `go build`, `go test ./...`, `go vet` and `gofmt` — which catch every
  identifier mistake, because a bad move does not compile. That is sufficient *for
  a pure move* and is the reason this task is safe at all: nothing about ordering
  changes. Anything that edits logic concurrently is out of scope here, and would
  need the hand-argument in `AGENTS.md` instead.
- **The engine boundary holds.** `round.go` must still know nothing about `Hub`,
  `Client` or SSE. A move that starts passing a hub type into the engine is not
  this task.
- Each commit compiles and passes the full suite, and reverts on its own.

## Why it waits on match-termination-owner

`finishMatch` is inside the matchmaking seam, so a split cannot avoid moving it.
[match-termination-owner](match-termination-owner.md) rewrites that function to
make the engine the single writer of termination. Doing the split first means
moving code that is about to be rewritten — paid for twice, which is the outcome
that task's own note is written to prevent. The rewrite should land in place, and
the split should move settled code.

## Unscheduled, not low-priority

Nothing forces this today. There is no defect here, no symptom, and no failing
test: the file is large, not wrong, and it compiles and passes. What would justify
starting it is a concrete occasion — a second pair of hands editing the hub, or a
hub-level change that needs a file of its own to live in. Absent one of those,
this is a task rather than an issue because the next action is fully specified and
can be handed over without a conversation; it is not scheduled because nobody has
asked for it. See [docs/register.md](../../register.md) on urgency being a
per-session judgement rather than a rank in the tree.