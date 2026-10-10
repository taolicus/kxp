# De-duplicate the client's start paths and drop dead surface

`web/app.js` is a single IIFE that has grown to just under 1,900 lines. Several
of its paths are the same shape written twice, and a little of its surface is
never reached. The duplication is the part that bites: the pending
invite-on-home work has to touch the create and re-mint paths this task would
settle first.

## The seams (lines as of the survey; names are the contract)

- **Challenge create/re-mint** — the online branch of `#btn-start` and the online
  branch of `#btn-again` both `post('/challenge', {roundsTarget, drawEnds})`,
  then on `res.ok` call `showInvite(token)` and a transition; they differ only in
  the transition event and the 409 notice. Extract one
  `mintChallenge(pair, event, onRefuse)`.
- **"Arm pending, post, re-arm on refusal"** — four copies (CPU start, Play
  Again, tower fight, online create) follow `armPending(btn); post(...).then(res
  => { if (!res || !res.ok) clearPending(); })`. Extract one
  `postPending(btn, promise, {onRefuse})`.
- **Fresh-entry match setup** — `enter.countdown` and `enter.shoot` repeat
  `setBg(d); showGame(); resetGame(); setYouSlot(); setOppSlot(...)`. Extract
  `enterMatchFromScratch(d, oppChar, oppName)`.
- **Teardown prefix** — `stopReadyLoop(); clearTimeout(stallTimer);` opens every
  non-game entry. Extract `leaveLiveRound()` and call it from each.
- **Readiness-gate predicate** — `state !== 'matched' && state !== 'result'` is
  written four times; make it one predicate.
- **DOM lookups** — `$('#…')` is used throughout, but eight sites reach for
  `document.getElementById`, and `#challenge-url` is looked up three different
  ways. Standardize on `$`.
- **`#btn-start` / `#btn-again`** are branch-heavy blocks mixing online / ladder
  / CPU. Once the two helpers above exist, split each into a small dispatcher.
- **Redundant `clearTimeout(slotTimer)`** — cleared twice in a row in the
  countdown painter with nothing scheduling it between the two.

## Dead surface

- `.tagline` in `web/style.css` matches no element in `index.html`, `app.js`, or
  any test.
- `data-floor` is written on tower rows in `app.js` but read only by
  `web/app.arcade.test.cjs`. Decide once: keep it deliberately as a test hook
  with a comment, or drop the attribute and scrape the row another way.

## Constraints

- **Behaviour-preserving.** This is a refactor; the client tests in
  `web/*.test.cjs` are the specification and must pass unchanged (except where a
  deleted attribute or DOM lookup is the thing under test).
- One extraction per commit, each green on its own. If a refactor needs a test
  change to stay pinned, that change rides in the same commit.
- No new screens, events, or wire fields. The invite-on-home work is a separate
  slice and is not smuggled in here.
- Rendering and CSS are unasserted on either host; the `.tagline`/`data-floor`
  deletions are hand-checked and stated as such.

## Acceptance

`npm run unit` green (the count unchanged unless a test is deliberately
retargeted), `npm run links` clean, and the start/invite handlers each a small
dispatcher over the shared helpers.

## Unscheduled, not low-priority

No defect and no failing test. It is scheduled ahead of the invite-on-home slice
in spirit, not by frontmatter: the two touch the same paths, and settling them
first means the later slice edits one helper rather than three copies.

## Landed

Every seam landed as its own green commit, in the order the survey listed them:
`mintChallenge` then `postPending` (the two helpers the rest waited on),
`enterMatchFromScratch`, `leaveLiveRound`, `readyGateOpen`, the redundant
`clearTimeout(slotTimer)`, the DOM-lookup standardization, the `startMatch` and
`playAgain` dispatchers, and the dead-surface triage. The acceptance holds: the
count never moved — `node --test web/*.test.cjs tools/lib/*.test.mjs` stayed at
222/222 on every commit, and `node tools/check-links.mjs` at 417/0. The one test
change rode in its slice: the harness lost its `document.getElementById` stub,
which app.js no longer reaches for now that every lookup is `$`.

The negative proof, since this is a refactor and the risk is a seam that keeps a
copy: the pins are the existing client tests, untargeted, and for the
standardization the check is that `grep -rn getElementById web/app.js` is empty —
the one remaining reference, renderInvite's DOM guard, now checks `querySelector`,
which is what `$` itself needs. A missed site would have thrown on the node it
could not find, not passed silently.

The two dead-surface decisions are recorded where they were made: `.tagline`
matched no element and was deleted — a hand-check, because CSS is asserted on
neither host — and `data-floor` turned out not to be dead, being the arcade
test's row-ordering hook read back off the markup, so it was kept with a comment
saying so rather than re-opened at the next survey. The invite-on-home slice can
now edit one create/re-mint helper and one start dispatcher instead of three
copies each.
