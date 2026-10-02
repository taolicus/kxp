# "Online now" counts +1 (ghost / half-open connection)

**Symptom** — the claimed online count has occasionally read one higher than
the real number of live players.

**Where it shows** — the "online now" counter in the UI vs reality.

**Working hypothesis** — a half-open SSE/TCP connection from a vanished device
kept counting (no reap), or an anonymous client minted without a matching
`connected` join. Neither is confirmed.

**Proves the cause** — client join/leave lifecycle logs + the now-shipped
bounded connection lifetime (Connectivity diagnostics slice): a `reap client …`
line, a matching `reaped` counter, a reaped half-open conn reconciling the count
down, or a leave with a non-empty frame journal but no matching `connected`
join.

**Diagnostic landings** — `/events` re-arms a rolling per-write deadline, so a
write stalled on a vanished peer reaps within the bound; TCP keepalive (15s) on
the listener catches silent idle peers; each client logs its last 16 flushed
frames on leave. The latency-profile trace waits on the `/ping` rework.

**Prospective fix (not scheduled)** — a permanent count-rule change waits until
the lifecycle/log/reap evidence identifies the survivor.
