# Dropped connection forfeits instantly (drop = loss)

**Symptom** — a TCP drop mid-match instantly forfeits via `opponent-left`, so a
vanished device reads as a loss for the opponent-left side.

**Where it shows** — live PvP during the ~3.2s match; drop rate is unmeasured.

**Working hypothesis** — intended (a drop *is* a loss of presence and the
remaining player legitimately wins), but the forfeit grace policy is arbitrary;
whether frequent drops would need a grace/backout is unknown.

**Proves the cause** — measured real-world drop frequency + whether drops land
mid-round vs between rounds.

**Diagnostic landings** — the server-side grace has now been *measured* rather
than assumed, and it is effectively zero. The `/events` handler defers
`endConn` (`server.go:327`), which calls `removeClient` and clears `c.match`
(`server.go:451-473`) the moment the old connection tears down. The only thing
that preserves a match across a drop is the `connID` staleness check inside
`endConn`, i.e. a reconnect that lands *before* the old handler's defer runs.
The protocol probe suite's `t6` drops the stream mid-countdown and reconnects:
even a **120ms** gap was enough to lose the round (snapshot came back
`state=idle`, not `ingame`). Recovery itself is healthy — the client lands in
the lobby, can start a fresh match, and is never stuck — so the cost of a drop
is a lost round, not a wedge. Still missing for this entry: real-world drop
*frequency*, and whether drops tend to land mid-round.

**Prospective fix (not scheduled)** — reconnection/grace race later; re-evaluate
only after drop data exists.
