# Every secondary screen returns through the lobby

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — Match History and the ladder tower both leave via the `mode`
edge to the lobby (`machine.js:35`, `46-58`); there are no direct routes
between secondary views. Getting from a finished match to the record of it is
three taps (Change mode → Match History); History → Arcade is two screens of
hub.

**Where it shows** — navigation between views, growing with every screen the
app adds.

**Working hypothesis** — hub-and-spoke keeps the state machine small and every
exit honest: each leave runs the lobby's entry, which clears match, series and
record state (`app.js:991-1014`). At six views the spoke cost is real but
bounded, and the alternative — direct edges — is exactly the kind of edge
table growth `machine.js` documents per-case (`machine.js:31-34`, `41-45`).

**Questions to resolve**

1. Which cross-routes are actually wanted (result → history? tower → history?),
   and does any of them skip lobby cleanup the spoke guarantees?
2. Is the honest answer "no cross-routes" — and if so, is that worth writing
   down so the next screen does not add one by accident?
3. Does a persistent header (home affordance) flatten the cost without new
   edges?

**Proves the cause** — a decision recorded against the state machine's edge
table as the invariant it would change; each new edge needs its entry/exit
semantics (what is reset, what is preserved) written before code.

**Prospective fix (not scheduled)** — whichever edges survive evaluation, added
one per slice with their handler semantics in the same commit.
