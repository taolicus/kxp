# Changing the lobby's match length silently discards an arcade run in progress

**Provenance** — read from the code in a UX review of the web client, not from an
observed session; the first thing to establish is whether it matters in use.

**Symptom** — tapping the lobby's match-length segmented control when the choice
differs from the current one calls `discardArcade()` (`app.js:1453-1456`),
deleting the saved ladder from localStorage with no notice. The next Arcade
Mode entry draws a fresh ladder at floor 1; nothing on screen says the old run
is gone.

**Where it shows** — the lobby, for any player mid-climb in Arcade Mode who
switches `1 round` ↔ `First to 3`.

**Working hypothesis** — the reset is deliberate: every floor of a run is fought
at the length captured when the mode was entered (`ladderTarget`, `app.js:24`,
`1412`), so a stored run would otherwise outlive the choice that made it
valid. The gap is that the cost is invisible at the moment of the tap — the
button label only distinguishes a *cleared* run (`app.js:420`), never a
discarded one.

**Questions to resolve**

1. Is the reset needed at selection time, or could a stored run carry its own
   length, with the control applying only to the next run?
2. If the wipe is required, is a one-line `#notice` enough, or should the
   control refuse the change while a run is live?
3. Does the guard need to cover other writers of the same key (a second tab)?

**Proves the cause** — a recorded decision: keep-the-run vs warn vs block,
stated against the ladder's length invariant wherever the ladder is documented.

**Prospective fix (not scheduled)** — whichever of the above wins, wired through
the existing `#notice` path (`app.js:981`) or a per-run length stored with the
order rather than read from the lobby at fight time.
