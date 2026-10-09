# Stop counting the harness-driven client tests in prose

Two documents count the client tests that drive the real `app.js`, and both say
two. Neither is true any more.

[verification](../../development/verification.md#the-gap-probes-cannot-close) says
the gap probes cannot close is why `web/app.countdown.test.cjs` and
`web/app.reconnect.test.cjs` drive the real `app.js` against a stubbed context,
and "Both load the same `web/appHarness.cjs`"; the note above the gates table
calls `web/app.countdown.test.cjs` "the test that runs the real `app.js` source".
[architecture](../../features/architecture.md#testing) says `npm run unit` covers
"the two files that run the real `app.js` against a stubbed context — the
countdown paint path and the snapshot reconciler", and that
`web/appHarness.cjs` "is shared by both client-behaviour tests".

Six files load `web/appHarness.cjs`: `app.arcade`, `app.countdown`,
`app.history`, `app.lobby`, `app.ready`, `app.reconnect`. A reader takes the pair
as exhaustive, which would have them conclude that client logic outside the
countdown and reconnect paths has no test — and it does, in four more files.

## What the fix is

Stop stating the set as a count of it: say `web/app.*.test.cjs`, or "every test
that loads `web/appHarness.cjs`", and keep the two files the paragraph was
written around as its examples rather than its whole content. The "shared by
both" sentence becomes "shared by all of them", which is the property it is
arguing for — a harness copied per test file is a second copy that drifts.

The precedent for replacing a count rather than refreshing it is
`4191c25` ("register.md stops stating counts that rot"): a count embedded in
prose is a second copy of the tree, and the copy is the thing that goes false
while the tree stays right.

## Why this is its own item

The claim was already false before the record view landed — `app.arcade`,
`app.lobby` and the rest were added without folding either sentence in — so it
is not part of any one of those slices. Rewording two paragraphs about how the
suite is organised can be reviewed and reverted on its own; folding it into a
feature commit would put a testing-docs rewrite in a diff nobody was reviewing
for that.

Verified while specifying, 2026-10-07: `grep -l appHarness web/*.test.cjs` lists
the six above.

## Landed

The counts are gone; the set is named by the glob that actually defines it.

**What changed.** [verification.md](../../development/verification.md) no longer
calls `web/app.countdown.test.cjs` "the test that runs the real `app.js` source"
— the gates note now points at "the client-behaviour tests — the
`web/app.*.test.cjs` files" — and its gap section now says "every
`web/app.*.test.cjs`", keeping countdown and reconnect as the examples the
paragraph was written around, with "Both load" changed to "They all load".
[architecture.md](../../features/architecture.md) § Testing likewise drops "the
two files" for "every `web/app.*.test.cjs`", and "shared by both
client-behaviour tests" is now "shared by all of them".

**Why the glob is exact, not a guess.** `grep -l appHarness web/*.test.cjs` and
`ls web/app.*.test.cjs` list the same six files (arcade, countdown, history,
lobby, ready, reconnect), so the shorter form and the loader set coincide today;
naming the loader is what keeps the sentence true if that ever stops being so.

**One document more than the task named.** The task counted two documents saying
"two" (verification and architecture); [README.md](../../../README.md) made the
same count — "two of them ... run the real `app.js`" — and was fixed in the same
slice, since the point is to stop stating the set as a count anywhere. AGENTS.md
names `web/app.countdown.test.cjs` as an example rather than a count, and stays
true, so it was left alone.

**Verified.** `npm run links` — 101 documents, 350 links, 0 broken. Docs only: no
code, so no gate's behaviour changed and `npm run unit` still runs the same 186
tests. The watchdog tests that landed in `web/app.reconnect.test.cjs` extended an
existing file, so the set this reword names is unchanged at six.

