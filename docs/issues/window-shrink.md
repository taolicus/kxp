# Weak-connection window shrink (high-latency honest loss risk)

**Symptom** — on a poor link, an on-time reaction can still be rejected `400
too late` because one-way delivery latency eats the effective window.

**Where it shows** — PvP over lossy/NAT'd links; the v1.1 announced schedule
removed the burst-delivery dependency but not one-way latency.

**Working hypothesis** — no loss of correctness (server stays
arrival-authoritative); the *effective* window simply shrinks with latency.
Whether this is common or significant in real play is unknown.

**Proves the cause** — an accepted `void`/late-grace rate profile from live
diagnostics, or `/ping`-measured one-way latency vs window. The `/ping` probe
that produces the second measurement has a parked draft spec: the "v1.3 —
`/ping` health probe" section in [docs/protocol.md](../protocol.md).

**Prospective fix (not scheduled)** — small server-side acceptance grace and/or
`clickedAt`-based cutoff (loses must stay arrival-authoritative), only after
the cause/latency is actually measured.

Two questions are already open against this entry and are recorded as their own
entries rather than folded in here: whether the ready-gate budget of 8s is
correct ([readiness-budget](readiness-budget.md)), and how long the latency
profile trace has to wait for a real one-way measurement — that one is a roadmap
task, "Latency profile visibility" in Phase 2.
