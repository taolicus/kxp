# Issues — observed symptoms awaiting a confirmed cause

A register of **live connectivity symptoms with no confirmed root cause yet**.
Each entry is a *description of what was observed* together with the current
working hypothesis; nothing here is a scheduled task. An entry does not return
to the roadmap as work until its cause is actually confirmed (see the "proves
the cause" gate on each).

Confirmed-correctness fixes that are *decided* regardless — e.g.
connectivity-safe `void` scoring — live in the roadmap, not here.

## How an entry graduates

An entry becomes a roadmap task when (a) the connectivity diagnostics slice
(roadmap item 5) narrows the cause to something concrete and (b) the specific
mitigation is then proven to address it. Parked here means: the cause is not
yet known well enough to build against.

---

## 1. Stuck in `matched` without a countdown (silent-stuck)

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

## 2. Reconnect recovery can read as a loss ("You lose" on reconnect)

**Symptom** — a player whose connection drops and who reconnects *during* a
match sometimes lands on a result that reports a loss (or misses the result
entirely) even though their reaction was on time.

**Where it shows** — TCP drop during countdown/shoot → reconnect → snapshot or
result reconciliation.

**Working hypothesis** — recovery (`/events` reconnect + backoff + snapshot)
takes ≥ the ~2s round window, so the effective window collapses; the residual
path is the 6s no-result watchdog / `opponent-left` forfeit. Cause of the
remaining loss-misread is not confirmed.

**Proves the cause** — a journaled reconnect faster than the window that still
loses, or a reconnect slower than the window (pure latency, not a protocol
gap).

**Prospective fix (not scheduled)** — stream seq + replay on reconnect (fast
recovery), a short result-acceptance grace, or `/ping`-measured reintent.

## 3. Weak-connection window shrink (high-latency honest loss risk)

**Symptom** — on a poor link, an on-time reaction can still be rejected `400
too late` because one-way delivery latency eats the effective window.

**Where it shows** — PvP over lossy/NAT'd links; the v1.1 announced schedule
removed the burst-delivery dependency but not one-way latency.

**Working hypothesis** — no loss of correctness (server stays
arrival-authoritative); the *effective* window simply shrinks with latency.
Whether this is common or significant in real play is unknown.

**Proves the cause** — an accepted `void`/late-grace rate profile from live
diagnostics, or `/ping`-measured one-way latency vs window.

**Prospective fix (not scheduled)** — small server-side acceptance grace and/or
`clickedAt`-based cutoff (loses must stay arrival-authoritative), only after
the cause/latency is actually measured.

## 4. "Online now" counts +1 (ghost / half-open connection)

**Symptom** — the claimed online count has occasionally read one higher than
the real number of live players.

**Where it shows** — the "online now" counter in the UI vs reality.

**Working hypothesis** — a half-open SSE/TCP connection from a vanished device
kept counting (no reap), or an anonymous client minted without a matching
`connected` join. Neither is confirmed.

**Proves the cause** — client join/leave lifecycle logs + bounded connection
lifetime (roadmap item 5, this entry's diagnostic half) showing a
counted-but-never-joined client, or a reaped half-open conn reconciling the
count down.

**Prospective fix (not scheduled)** — connection reap / deadline set ships as
part of the diagnostics slice to test this hypothesis; a permanent count-rule
change waits until the lifecycle logs identify the survivor.

## 5. Dropped connection forfeits instantly (drop = loss)

**Symptom** — a TCP drop mid-match instantly forfeits via `opponent-left`, so a
vanished device reads as a loss for the opponent-left side.

**Where it shows** — live PvP during the ~3.2s match; drop rate is unmeasured.

**Working hypothesis** — intended (a drop *is* a loss of presence and the
remaining player legitimately wins), but the forfeit grace policy is arbitrary;
whether frequent drops would need a grace/backout is unknown.

**Proves the cause** — measured real-world drop frequency + whether drops land
mid-round vs between rounds.

**Prospective fix (not scheduled)** — reconnection/grace race later; re-evaluate
only after drop data exists.

---

Entries move out of this register only when the Observability roadmap slice
(often next to each "proves the cause" line) supplies the confirming evidence.
Until then the roadmap shows only decided work and the diagnostic slice itself.
