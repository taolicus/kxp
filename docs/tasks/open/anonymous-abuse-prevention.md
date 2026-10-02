---
priority: 9
phase: 1
depends-on: []
gated-on: []
---

# Anonymous abuse prevention

Enforce a max number of anonymous clients per IP or time window.

## Why it is deliberately below the other Phase 1 work

The current priorities treat this as postponed until the feature set settles, and
the risk is accepted while the game is small-scale. The per-IP token bucket on
POST endpoints and the resource caps already landed and are the mitigation that
made deferral defensible; this is the residue, and it is scheduled behind the
work that changes what an anonymous client is worth.

## Notes

- The archive question is open and scoped, not undecided: no client-side
  anti-cheat, server-side only. Raise it as its own issue if a client-tampering
  signal appears rather than pre-empting the threat model.
