# Connectivity diagnostics — the landed traces

Landed. Status and summary live in the roadmap entry under
**Phase 2 — Testing & observability** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

Landed so far: a per-request access log (`accessLog`,
method/path/status/duration) and an error log at every `handlerError`
(`kxp: reject <code> "<msg>"`), exercised by `logging_test.go`; client
join/leave lines carrying the live count; the `/metrics` counter endpoint
(requests, rejects by code/message, joined/left, dropped events,
rate-limited, SSE streams, client error beacons by kind, **reaped
connections**); the `/health` probe; and the client-side error beacon
(`POST /report`, throttled client-side via `beaconGate`, hooked at SSE
errors, fetch failures, machine-rejected transitions, stall-watchdog
fires, and rejoin-past-window).

**The bounded SSE connection lifetime is in too**: `/events` re-arms a
short rolling per-write deadline before every frame, so a write that
stalls against a vanished peer (half-open conn) reaps the connection — the
client is removed, the online count reconciles down, a `reap client …`
line joins the `leave online=N` line, and the `reaped` counter moves. TCP
keepalive (15s) arms at the listener so the OS also notices silent idle
peers between frames. Each client logs a short **frame journal** (last 16
event types actually flushed) on leave, so a vanished/reaped device's
last-seen can be correlated with its reconnect or beacon.

Still open here: structured (JSON) log output — its own item below.
