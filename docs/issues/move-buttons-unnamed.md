# The move buttons have no accessible names

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — the three `.move` buttons contain only an emoji
(`index.html:95-97`), so their computed accessible name is the emoji's
platform-dependent CLDR name ("victory hand", "raised fist", …) rather than
Rock, Paper, Scissors. The fighter buttons already carry `aria-label`
(`app.js:666`); the moves never grew one.

**Where it shows** — the game view's primary action, for screen-reader and
some switch-device users.

**Working hypothesis** — emoji was assumed to speak for itself; the name a
screen reader announces does not match the game's vocabulary and varies by
platform.

**Questions to resolve**

1. `aria-label="Rock|Paper|Scissors"` per button — is there any reason to
   include the countdown chant (KA/PUN/CHI) in the label, or is that flavour
   only?
2. Does the picked-state flash (`app.js:718-722`, `.move.picked`) need a
   non-visual equivalent for the same reader, or is the `locked` stage text
   (`rejectLabel`, `kxp.js:165`) enough?

**Proves the cause** — nothing to measure: the only open question is
acceptance. Once accepted this is one small build and could move straight to
a task; it is parked here so the a11y cluster is evaluated together
(see [no-live-announcements](no-live-announcements.md),
[view-switch-keeps-focus](view-switch-keeps-focus.md)).

**Prospective fix (not scheduled)** — `aria-label` on the three buttons in
`index.html`; no behaviour change.
