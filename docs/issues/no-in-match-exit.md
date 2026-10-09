# There is no way to leave a match once it has started

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — the machine offers `cancel` only from `waiting` and `matched`
(`machine.js:22-23`); from `countdown`, `shoot`, `locked` and `result` the only
exits are a completed match or the 6s stall watchdog's reconnect
(`app.js:62-75`). The game view carries no quit affordance, so a player who
wants out mid-match can only close the tab — which costs the opponent the
match via the forfeit rules ([drop-loss](drop-loss.md)).

**Where it shows** — the game view, the length of every round and series.

**Working hypothesis** — deliberate: a round lasts seconds, the server judges
by arrival, and a graceful quit would need forfeit semantics the server does
not expose (`/cancel` covers the queued/matched span — check the server before
assuming anything beyond it). Closing the tab already has defined behaviour;
a button would be a friendlier version of the same outcome, not a new one.

**Questions to resolve**

1. Is an in-match exit in scope at all, given round length — or is the real
   gap only the *between-rounds* pause of a series, which can last until the
   ready gate times out?
2. If in scope: reuse the opponent-left outcome, or a distinct forfeit the
   other side is told about honestly ("Opponent forfeit", not "left")?
3. How does it interact with the grace question parked in drop-loss?

**Proves the cause** — a decision that the exit is wanted, plus the
server-side semantics it would need (named in a task before any client
button).

**Prospective fix (not scheduled)** — server forfeit endpoint first; the
client button is the last slice of that work, not the first.
