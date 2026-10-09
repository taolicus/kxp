# A disabled Play Online button does not say why

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — Play Online is disabled whenever the online count is zero
(`app.js:243`). The count and its dimmed dot sit above in the same muted style
(`style.css:220-229`), with no programmatic link (`aria-describedby`, `title`)
and no change to the button itself: at a glance it reads as a broken control,
and the explanation is a line the eye may not connect to it.

**Where it shows** — the lobby, whenever nobody else is online — including the
first-ever visit, which is the worst moment for a dead primary button.

**Working hypothesis** — the dot + count was considered sufficient; the two
elements were styled as a pair but never wired as cause and effect.

**Questions to resolve**

1. `aria-describedby` pointing at `#online`, a visible hint under the button,
   or both?
2. Should the empty state offer the alternative that works offline ("Challenge
   a friend" / CPU), rather than only explaining the dead end?
3. Does the lobby unit spec pin the disabled behaviour
   (`web/app.lobby.test.cjs`) — check before changing what the count drives.

**Proves the cause** — a decision on the empty-lobby affordance.

**Prospective fix (not scheduled)** — described-by wiring plus, if chosen, a
hint line shown only when the count is zero.
