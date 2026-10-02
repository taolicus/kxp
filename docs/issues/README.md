# Issues — observed symptoms awaiting a confirmed cause

A register of **live connectivity symptoms with no confirmed root cause yet**.
Each entry is a *description of what was observed* together with the current
working hypothesis; nothing here is a scheduled task. An entry does not return
to the roadmap as work until its cause is actually confirmed (see the "proves
the cause" gate on each).

Confirmed-correctness fixes that are *decided* regardless — e.g.
connectivity-safe `void` scoring — live in the roadmap, not here.

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

## How an entry graduates

An entry becomes a roadmap task when (a) the connectivity diagnostics slice
narrows the cause to something concrete and (b) the specific mitigation is then
proven to address it. Parked here means: the cause is not yet known well enough
to build against.

---

Entries move out of this register only when the Observability roadmap slice
(often next to each "proves the cause" line) supplies the confirming evidence.
Until then the roadmap shows only decided work and the diagnostic slice itself.
