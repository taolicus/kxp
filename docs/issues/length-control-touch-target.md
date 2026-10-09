# The match-length buttons are below the comfortable touch minimum

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — `.seg-btn` is `padding: 0.35rem 0.7rem` at 0.9rem font
(`style.css:249-258`) — roughly 30px tall on a phone, under the ~44px
guidance iOS and Android publish, on the control that decides how every match
is played. The other controls are sized generously by comparison (`.move`:
`padding: var(--s4) 0.5rem`, `style.css:427`).

**Where it shows** — the lobby's length control, every time it is tapped.

**Working hypothesis** — the segment was sized as an inline chip beside its
label, not as a primary decision control; the lobby has vertical room to give.

**Questions to resolve**

1. Enlarge padding or add a `min-height` without breaking the row's baseline
   alignment with the "Mode:" label (`style.css:239-247`)?
2. Does the whole `.seg` row become one larger tap strip (each button filling
   the row's height), and does that interact with the selected-state question
   ([length-control-label](../tasks/closed/length-control-label.md))?
3. Any change here is visually unassertable on either host — hand-checked,
   and stated as such.

**Proves the cause** — a decision on sizing, ideally decided with the label and
selected-state questions for the same control in one slice later.

**Prospective fix (not scheduled)** — padding/`min-height` bump on `.seg-btn`;
no behaviour change.
