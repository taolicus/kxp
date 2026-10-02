# Tell the player *why* a handshake was cancelled

Landed. Status and summary live in the roadmap entry under
**Phase 1 — Core hardening** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

Reading the requeue path end to end first turned up a worse bug than the
missing message: `makeMatch` wired the *same* requeue closure for CPU and
PvP, so a CPU handshake timeout put the player into the **PvP queue** for a
human opponent they never asked for. `requeueSide(1)` correctly no-ops for
the bot, but side 0 never checked the mode. Fixed at the source (the
closure captures `cpu` and declines to queue), and pinned by
`TestCPUReadyTimeoutReturnsHumanToLobby`, which asserts the human is *not*
on the queue — the inverse of the test it replaced.

The second half was the invisible queue. `requeue` sets `queueing` and
calls `tryMatch`, but the client was told `state idle`, so a re-queued
player sat in a lobby that looked idle while the server held them in the
queue: no Searching view, no Cancel, and re-matched again within the gate
window. So the teardown frame now carries `reason` and `requeued`, and
`requeued` is present only when the server actually queued that side.

**Additive on purpose, and that was not the obvious choice.** Swapping the
event type for `waiting` would have reused the frame `/queue` already
sends — but `waiting` has no `matched -> waiting` edge in the client
machine, and adding it does not help a client that predates the change. A
tab open across a deploy would strand itself on the game screen with a
rejected transition. Keeping the frame as `state idle` and adding fields
means an old client ignores them and behaves exactly as before. The client
needed one new edge (`matched + waiting = waiting`) to avoid a lobby flash,
which is safe precisely because the wire format did not change.

Not scoped, and deliberately: no blame. The server cannot attribute a
timeout to a player — it observes an ack that did not arrive, which is
equally consistent with a slow upload, a stalled connection, or a device
that slept. The copy states the cause it can prove ("Connection wasn't
ready in time — match cancelled") and never which player was at fault, and
it must not read as a loss: no `result` is emitted, so nothing is scored
(pinned by `TestFinishedMatchTeardownCarriesNoReason` and the CPU test).

Also `readyAbandon` was folded in, as decided: the survivor of an opponent
disconnect now learns `opponent-left` through the same field.

*Landed: `abandon`/`requeued` on the engine match, mode-aware requeue in
`makeMatch`, the reason on the teardown frame, the client notice above
whichever view is showing, and t5 asserting a finished match's teardown
stays bare. Verified to fail against the pre-change payload.*
