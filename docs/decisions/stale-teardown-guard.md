# Stale `state` teardown after a handshake re-pair

Landed. Status and summary live in the roadmap entry under
**Phase 1 — Core hardening** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

**Fixed.** The teardown frame is now per-side and conditional: only a side
still in *this* match is told to go idle, decided under `h.mu` because
`Client.match` is plain state and an unlocked read would be a data race
(and `-race` cannot run on the arm64 dev device). `drainMoves` stays
unconditional — that channel is the client's own, and a re-paired client
must not open its new round on the old round's buffered pick.

Three unit tests in `finish_test.go` drive the pointer states directly,
because the live race is order-dependent and a clean probe run is not proof
of absence: a re-paired side gets no frame, an already-removed side
(`match == nil`) gets no frame, and the normal path still tells **both**
sides to go idle — that last one is the guard against over-correcting into
stranding every finished client. The two bug-catching tests are the
first and second; the third passes against both servers, since it exists
to catch an over-correction rather than the original defect.
*Previously observed via the protocol probe suite's `t8` scenario B,
roughly 1 run in 7 (order-dependent); `t8` still asserts it as a live
canary. Not filed in [docs/issues/](../issues/): that register holds
symptoms whose cause is unconfirmed, and this one's mechanism was traced.*
