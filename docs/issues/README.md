# Issues — observed symptoms awaiting a confirmed cause

A register of **live symptoms with no confirmed root cause yet**, plus the
**open questions** those symptoms have raised and the repo has not answered.
Each entry is a *description of what was observed* — or, for a question, a
statement of what is unknown — together with the current working hypothesis.
Nothing here is a scheduled task: an entry does not become work until it is
actually understood, and the "proves the cause" (or, for a question, the
evidence or the decision) is the gate.

Decided-correctness fixes that are *decided* regardless — e.g.
connectivity-safe `void` scoring — live in
[docs/tasks/open/](../tasks/open/), not here. So does anything with a known
approach that merely has low priority; that is a task too.

Being in this directory *is* an entry's status: ungraduated. Nothing per-entry
restates it, so a reader cannot find a second copy to disagree with.

## Entries

Cite an entry by its slug, which is its filename — not by number, which rots the
moment an entry is inserted or removed.

- [`silent-stuck`](silent-stuck.md) — a player sits in the "match found" view with
  no countdown ever starting
- [`reconnect-loss`](reconnect-loss.md) — reconnecting during a match reads as a loss
- [`window-shrink`](window-shrink.md) — an on-time reaction rejected on a high-latency link
- [`ghost-connection`](ghost-connection.md) — "online now" counts one higher than reality
- [`drop-loss`](drop-loss.md) — a dropped connection forfeits the round outright
- [`game-screen-hiccup`](game-screen-hiccup.md) — restarting after a long idle
- [`readiness-budget`](readiness-budget.md) — *question:* is 8s the right ready-gate budget?
- [`player-identity`](player-identity.md) — *question:* which player-identity model?

## How an entry graduates

An entry becomes a task when the next action is **build X**, and a written
[decision](../features/) or a measured number is all that stands between it and
the work items. A symptom whose cause is still unconfirmed cannot: the whole
point is that nobody yet knows what to build. So an entry leaves here when its
"proves the cause" line is satisfied, or when what it needs is a decision
rather than evidence — in which case the decision is recorded here as its own
entry, the way `player-identity` carries the blast radius of the tasks it gates.

Entries move out of this register when the diagnostics work supplies the
confirming evidence: `docs/tasks/closed/connectivity-diagnostics-traces.md` for
the traces that landed, and [latency-profile-visibility](../tasks/open/latency-profile-visibility.md)
for the one still waiting on a measurement. Nothing graduates on a timer.
