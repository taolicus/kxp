# Weak-connection window shrink (high-latency honest loss risk)

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
