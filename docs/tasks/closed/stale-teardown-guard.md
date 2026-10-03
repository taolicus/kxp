# Stale `state` teardown after a handshake re-pair

When a PvP ready handshake is abandoned, `readyTimeout`/`readyAbandon` re-queue
both sides and `m.requeue` calls `tryMatch`, which can re-pair the survivor into
a *new* match before the abandoned match's `m.finish` → `finishMatch` runs.
`finishMatch` then sent `state {state:"idle"}` to every side of the old match
**unconditionally**, without re-checking `client.match == m` the way it does for
the match teardown itself (`server.go:637-642`). The survivor could therefore
observe `matched` (new match) *then* `state` (stale teardown), in either order
depending on goroutine interleaving — the two frames are emitted within the same
millisecond. Client impact: the browser reads that trailing `state` as a
`stateIdle` edge out of `matched` and drops to the lobby while the server still
holds it in a live match (see the `matched` row in
[docs/features/protocol.md](../../features/protocol.md)).

→ rationale: [decisions/stale-teardown-guard.md](../../decisions/stale-teardown-guard.md)
