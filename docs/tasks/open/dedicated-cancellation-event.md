---
priority: 8
phase: 1
depends-on: []
gated-on: []
---

# Dedicated cancellation event instead of additive `state idle` fields

`state {state:"idle", reason?, requeued?}` overloads one frame with two meanings:
"a match finished" and "this handshake was cancelled". The client then has to
derive intent from payload and carry a special edge (`matched + waiting`, taken
only when `requeued` is true) that exists purely because of that overload. A
dedicated `cancelled {reason, requeued}` event would let `state` mean one thing
and let the client table say it directly.

## The additive fields were the right call, though

See the Phase 1 entry "Tell the player *why* a handshake was cancelled": a
pre-existing client ignores unknown fields and behaves exactly as before, whereas
an unknown *event type* is dropped silently and would strand a tab open across
the deploy on the game screen. So this only becomes worth doing if the deploy can
guarantee clients refresh, which is currently outside this repo (an ops script,
`git pull` + build + restart).

## Fold-in

Park it as a post-rework cleanup, and fold in the version handshake it would
need: a `clientVersion` field on `connected` would let the server emit
per-vintage frames and would also give the parked seq/replay work a place to hang
compatibility.

## Why this is still a task and not an issue

The wire-breaking risk is a reason to defer, not a reason to leave the next action
unknown: "add a `cancelled` event and a `clientVersion` field once the deploy can
guarantee refresh" is a specified build, not a question waiting on evidence.
