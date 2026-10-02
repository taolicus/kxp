# Both ends of the pick window are authoritative

Landed. Status and summary live in the roadmap entry under
**Phase 1 — Core hardening** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

**The gap.** `handleMove`'s late check reads the clock, then stamps
`arrive` from a *second* read a few lines later. A pick submitted in the
final sliver of the window can pass the check and be stamped past the
deadline, and `drainPending` counts it as an on-time tap. `resolve` then
called it valid and let it **win the round** on a move the server would
have rejected with `400 too late` a moment later. The handler's own
comment claimed the accepted move was "never silently corrupted"; the
reasoning behind that ("drainPending counts anything buffered before the
deadline fired") assumes buffered means before the deadline, which is
exactly what the double read can violate. Confirmed by driving the engine
directly: a rock against scissors arriving 40ms after the deadline
resolved as `win` before this change.

**Fixed at both ends.** The handler samples the clock once, so the
late-bound check and the arrival stamp cannot disagree; and `resolve` now
judges `arrive` against the whole announced window, `[shootAt, deadline]`,
so the authority that decides the round does not depend on a caller having
checked correctly. A pick stamped at the instant the window closes is not
*after* it and still counts, which the boundary test pins — the client
renders the window as closing at that same instant, so rejecting it would
take the boundary away from a player who was inside it.

**`late`, deliberately not `timeout`.** Connectivity-safe scoring (Phase 1)
keys a no-contest on the `timeout` note, and it keeps `early` out of that
rule because an early pick is a deliberate act that stays a full loss. A
late pick is the same kind of act, so it gets its own note rather than
being folded into `timeout` — otherwise the planned `void` work would
silently convert it into a draw-scored no-contest. Pinned by a test that
fails if `late` is ever reported as `timeout`.

**Testing.** Driven directly against `resolve` with hand-set arrival
instants — no run loop, no channels, no sleeping, since the judgement is a
pure function of the two arrivals. The disqualification test was checked
to *fail* against the old one-sided check (it resolved `win`); the
at-the-deadline guard passes both before and after by design, existing to
catch an over-correction; the `late`-is-not-`timeout` test also passes
both, pinning the contract choice rather than the original defect.
