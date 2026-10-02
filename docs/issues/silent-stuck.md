# Stuck in `matched` without a countdown

**Symptom** — a player sometimes sits in the "match found" view with no
countdown starting, indefinitely, with no error surfaced.

**Where it shows** — online queue → `matched` → `countdown` transition never
fires or the client never actionably reacts.

**Working hypothesis** — the happy path depends on a single unacknowledged SSE
`countdown` frame over one stream; a stall or drop on that frame (recovered
only by a slow reconnect ≥ the round window) leaves the client waiting on a
dead end. Protocol v1.1 removed most of this dependency by pre-announcing
`shootAt` at KA; whether any residual stuck path survives is unproven.

**Proves the cause** — an SSE subscription that reports `matched` but never
receives countdown frames (or a client backoff/backout default that is never
triggered) while a diagnostic journal shows the frame was actually delivered.

**Prospective fix (not scheduled)** — stream seq + frame replay on the SSE
`id:`/`Last-Event-ID` path, and/or an "opponent found but stalled" client
backout.

*Draft spec for the replay half exists:* the "v1.2 — stream sequence numbers +
replay" section in [docs/protocol.md](../protocol.md), marked parked. It
graduates only if diagnostics confirm frames are actually being dropped or
arriving unrecoverably. The same fix also addresses
[reconnect-loss](reconnect-loss.md).
