# Nothing announces state changes to assistive tech

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — `#notice`, `#banner`, `#count` and the stats/pips update as
plain DOM; there is no `aria-live` or `role="status"` anywhere in
`index.html`. A screen-reader user gets no signal that a match was found, the
countdown advanced, the PUN window opened, a round was won, or a handshake was
cancelled.

**Where it shows** — every transition of the game flow; the whole app, for a
non-visual user.

**Working hypothesis** — the UI is visual-first and the live regions were never
chosen. The set that matters is small: match found, result, notice — the
per-second countdown is the interesting one (below).

**Questions to resolve**

1. Which elements are live, and at what politeness — announcing READY → KA →
   CHI → PUN every second would be noise; is one announcement per countdown
   (or only PUN and the result) right?
2. Do the move buttons need an announcement when they unlock, or does the PUN
   stage text carry it?
3. Who verifies this — neither host has an automated screen-reader pass, so
   verification is hand-checked on a device with a screen reader and must say
   so.

**Proves the cause** — a decision on the announcement set, then a hand-checked
pass recorded in whichever task lands it.

**Prospective fix (not scheduled)** — `role="status"` on `#notice` and
`#banner`, a single live announcement for the round outcome; countdown
treatment per the decision above.
