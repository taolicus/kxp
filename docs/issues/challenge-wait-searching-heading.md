# The challenge wait shows the matchmaker's heading

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — the queue view's heading is hard-coded "Searching for an
opponent…" (`index.html:69`). A challenge creator lands on the same view with
the share-link block below it (`index.html:70-74`, shown when
`challengePending`, `app.js:1025-1028`), so the screen announces a search
while actually waiting on one named friend.

**Where it shows** — queue view, Challenge a Friend path, for the whole wait.

**Working hypothesis** — the copy was written for the matchmaker path and never
forked. `waiting()` is the single place both paths pass through and already
reads `challengePending` to decide the link, so the heading has the same
branch available.

**Questions to resolve**

1. What should the creator's heading say ("Waiting for your friend…"?) — and
   should the claimant's brief wait keep the searching copy?
2. Does the cancel button's label change with it, or is one "Cancel" right for
   both waits?

**Proves the cause** — a copy decision, and confirmation of which paths reach
`waiting` with `challengePending` set (creator only today).

**Prospective fix (not scheduled)** — set the `h2` text in `waiting()` beside
the existing link toggle.
