---
phase: 2
depends-on: []
gated-on: []
---

# Browser e2e: two real tabs play a PvP match to a mirrored result

The third browser slice: the online queue from the browser side. Two tabs both
queue, both auto-ack, both get a countdown and a PUN window, both click moves,
and both render results that mirror each other without either tab stranding.

## Required context

- [protocol.md](../../features/protocol.md) § matchmaking and § PvP: FIFO
  pairing, the self-pair guard, the mirrored result rule (win↔loss,
  draw↔draw).
- [architecture.md](../../features/architecture.md) § Matchmaking: a PvP match
  needs **both** ready acks before any countdown; two rAF gates closing at once
  is the browser-only claim this slice makes, since `tools/t8-pvp.mjs` proves
  the wire both-sides resolution with no DOM at all.
- The old withdrawn suite flow 2 (`git show 31a0384^:e2e/gameplay.spec.js`) is
  the structural ancestor; carry over its acceptance of a stranger grabbing a
  queue slot (degrade to completion invariants rather than failing on pairing
  luck).
- [browser-cpu-match-e2e](../closed/browser-cpu-match-e2e.md) has landed; share
  its helpers rather than copying them.

## Scope

`e2e/pvp.spec.js`, one test with two `page`s (or two contexts): queue both with
the same length/rule, wait for the self-pair marked by `matched` on both sides
(cross-check `opponentCharacter`), assert countdown beats on both, click one move
per side inside each window, and assert both result panels render with mirrored
outcomes and zero console errors on either tab. If a live stranger joins before
the self-pair, fall back to asserting that both tabs complete a match against
whatever they paired with — neither stranded is the invariant, not the identity
of the opponent.

## Verify

`npm run e2e -- -g "PvP"` on the laptop against the deployed origin; a
deliberately wrong expectation (e.g. one side mirrored as a win on both) must
fail; `/health` → `activeMatches: 0` afterwards. Device: laptop only.