# The fighter picker's back button leaves the state machine out of it

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — "Change mode" on the choose screen calls `show('lobby')` directly
(`app.js:1499`) instead of a transition. Every other exit from a non-lobby view
goes through `transition('mode')` (`machine.js:35`, `46-58`), which runs the
lobby's entry handler (`app.js:991-1014`) — clearing any `#notice`, the ready
loop, the stall watchdog, and the in-progress match context. The picker's path
does none of that; today nothing happens to be stale when it is pressed, so
the divergence is invisible.

**Where it shows** — the choose screen's "Change mode" button; invisible until
a future lobby-entry change assumes entry ran.

**Working hypothesis** — the picker is not a machine state (the machine is
still in `lobby` while it is open — `machine.js:37-38`), so when the button
was added there was no edge to take and the direct `show()` was the shortest
path.

**Questions to resolve**

1. Is the right fix a `pickback`-style edge to `lobby`, or calling the same
   cleanup inline — given that a transition would run *all* of the lobby entry
   (including notice clearing, which is the visible difference today)?
2. Does `pendingMode` need explicit clearing on the way out, or is the stale
   value harmless as now?

**Proves the cause** — confirmation of what lobby entry does today that this
path misses, and a decision on the fix shape. The divergence is provable from
the code; whether it ever *bites* is the open part.

**Prospective fix (not scheduled)** — route the button through the machine so
the next lobby-entry change cannot miss this path.
