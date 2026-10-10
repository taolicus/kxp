---
phase: 2
depends-on: []
gated-on: []
---

# Consolidate the client test scaffolding

The client tests in `web/*.test.cjs` each grew their own copy of the same few
fixtures. The harness (`web/appHarness.cjs`) already owns the stub context and
the `BGS` shared fixture, so the repeated pieces belong beside it rather than
copied per file. Pure test refactor: no production file changes.

## What is duplicated (lines as of the survey; behaviour is the contract)

- **`newApp`** — defined in both `app.history.test.cjs` and
  `app.arcade.test.cjs`, differing only in the default roster. Move one factory
  onto the harness.
- **`showing`** — byte-identical in those same two files.
- **`.view` seeding** — the "build stub elements, set ids, `seed('.view', …)`"
  block repeats, differing only in which screens.
- **The boot + `connected` fixture** — the same connect-then-fire-`connected`
  setup appears in six files, and the literal
  `connected { id, now, online: 0 }` payload verbatim in three. Add one
  `bootConnected()` helper to the harness.
- **The length-control button builder** — `[[1,'true'],[3,'false']]` stub
  buttons plus `seed('#cpu-length .seg-btn', …)` is built identically in the
  arcade and lobby tests.
- **`bodyOf` / `askedFor`** — the last-POST-to-a-path readers; keep one generic
  version and derive the specialised projection from it.
- **Fixtures** — `ROSTER` and the `runInContext("id = 'c1'", …)` seed repeat
  across files; the 3- and 4-fighter rosters differ by one row.

## Also fix here

Three test comments cite `app.js:NNN` line numbers that have drifted
(`app.reconnect.test.cjs` header and routing-table comment,
`lobby-markup.test.cjs`'s `#btn-history` reference). Correct them or drop the
numbers in favour of the declaration name, as the survey-style comments
elsewhere do.

## Constraints

- **No production edits.** If a helper only makes sense by changing `app.js`, it
  is out of scope.
- Consolidate one fixture per commit; each must leave `npm run unit` green.
- Do not move a fixture that is genuinely local to one file just to reduce the
  file count — the goal is to remove copies, not to centralise everything.
- The harness is shared by every client test, so a helper added there is covered
  by the whole suite; a change that breaks one test file is a harness bug.

## Acceptance

`npm run unit` green with the same number of assertions that matter (moving a
fixture changes line counts, not coverage); `npm run links` clean.
