# Readiness as a lease, not a latch

Asked whether there was a robust mechanism for a client to announce readiness.
There was a sound one for *delivery* and a broken one for *meaning*.

Delivery was already right: `POST /ready` is at-least-once (the client re-posts
every 2s while matched), the server side is idempotent via a CAS bitmask, the
wait is bounded at 8s and then cancels, arrival time is authoritative so no
client clock is involved, and a disconnect or a `pending` reconnect is handled.
What that bought was "bytes for an ack reached this browser".

The defect was that `m.ready` was a bitmask — a side that acked once counted
forever. So a side that acked and then vanished for good still satisfied the
gate: the opponent's late ack opened the countdown and fired a round at an absent
player, which is the same failure the readiness work was for, reached by a
different route.

Replaced the bitmask with a per-side timestamp and a 4s lease, re-tested every
250ms in `waitReady` rather than once, so freshness is judged at the moment the
gate actually opens. `readyLease` sits above the client's 2s re-ack interval on
purpose: a client that keeps acking correctly must not be able to expire its own
lease between acks. Renewal therefore cannot short-circuit on a side that has
already acked, which is the bug the obvious implementation has.

Also closed `handleReady`'s fallthrough, which answered `200` for an ack recorded
against nobody when `indexOfMoves` returned -1. I could not trace a reachable
route — `moves` is set once in `makeMatch` and never cleared — so it is a guard
against an invariant violation rather than a fix for an observed failure. The
handler must never return `200` for an ack that did not register, because the
client reads `200` as "the countdown is coming".

Known limit, deliberately not paid for: a side that acks and is then hidden
within the window before the countdown starts still counts as fresh, since
nothing re-checks after the gate opens. Closing it means refusing to open until
every side has acked across a full renewal interval — a fixed multi-second delay
on the start of every round, which is worse than the narrow window it removes.

Two pre-existing hazards surfaced while testing and were fixed in passing:
`allHumanReady` nil-panicked through `snapshot` (the reconnect path) on a match
built as a struct literal, and `ackReady` closed a nil `readyCh` on such a match.
Neither was introduced by the lease, and neither had coverage.

→ rationale: [protocol.md#why-readiness-is-a-lease-not-a-latch](../../features/protocol.md#why-readiness-is-a-lease-not-a-latch)