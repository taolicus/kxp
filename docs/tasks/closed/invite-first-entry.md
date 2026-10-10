# Invite-first entry

Hitting *Play Online* opens one screen that reserves the player and hands them a
code to share, beside a field for pasting someone else's. This is the decided
shape of [matchmaking-share-code-overhaul](../../issues/matchmaking-share-code-overhaul.md):
the separate *Challenge a Friend* mode disappears and reservation is the default,
with a secondary "search for anyone" control as the fallback.

## Required context

- *Play Online* today posts `/queue` and optimistically transitions to the queue
  view (`web/app.js:1554-1563`); *Challenge a Friend* is a second mode
  (`web/app.js:1658`, `openChoose` at `:779`) that mints `/?challenge=TOKEN` and
  un-hides the link inside the queue view (`enter.waiting`, `:1140-1156`).
- The reservation survives reloads/reconnect and is player-keyed; the snapshot
  carries `challenge` and rebuilds the link (`web/app.js:1405-1414`). Protocol:
  `docs/features/protocol.md` `POST /challenge`, `POST /join`, `POST /cancel`.
- The claim latch (`window.__challengeJoined`, `web/app.js:1383-1403`) already
  auto-claims a visited `?challenge=` link once per page load.
- The state machine is `web/machine.js`; `lobby -> waiting` is already an edge
  and the "choose fighter" screen is *not* a state.
- Lobby markup and its pins are `web/index.html:24-62` and
  `web/lobby-markup.test.cjs`; challenge client behaviour is pinned by
  `web/app.challenge.test.cjs`.

## Constraints

- **Opaque link.** The code is the existing token in `/?challenge=TOKEN`; the
  paste field accepts a full URL or a bare token.
- **Explicit claim.** Confirm posts `/join`; `404`/`409` surface inline. A
  visited `?challenge=` link may still auto-claim.
- **Search for anyone** leaves the reservation (same intent as Cancel) and joins
  the FIFO at the lobby's chosen length.
- Wire change is additive; the engine is untouched.

## Acceptance criteria

- *Play Online* mints a reservation and shows the invite screen (your link, a
  Copy control, a paste field with Confirm, "search for anyone", Cancel); the
  *Challenge a Friend* entry is gone.
- Pasting a full URL or a bare token and confirming pairs through
  `/join`; a bad code shows the inline error and leaves the screen usable.
- "Search for anyone" cancels the reservation and joins the queue at the lobby's
  length.
- A reload/reconnect while reserved rebuilds the invite screen from the snapshot.
- Play Again after an online match returns to the invite screen with a fresh
  code.
- Negative direction: a plain queued player (no reservation) sees no invite
  code.
- Tests: extended `web/app.challenge.test.cjs` / `web/lobby-markup.test.cjs`
  against the real `app.js`.

## Notes

- Device: client + markup, `node --test` on the phone; rendering is hand-checked
  (no e2e here).
- Share API is [invite-share](../open/invite-share.md), a follow-up so the Web-API stub
  work stays out of this slice.
- The stale state list comment at `web/app.js:9` can be corrected here.

## Landed

*Play Online* now mints a reservation at the lobby's chosen length and shows the
invite screen; the *Challenge a Friend* button and its `challenge` mode are gone.
The waiting screen gained a paste field (`#claim-url`/`#btn-claim`, inline
`#claim-error`), a "search for anyone" control (`#btn-search`, posts `/cancel`
then `/queue`), and a title that reads as invite or plain wait. `showInvite`,
`tokenFromPaste`, `renderInvite` and `setClaimError` live in `web/app.js`;
`enter.waiting` paints from the reservation flag, the snapshot rebuild reuses
`showInvite`, and Play Again after an online match posts `/challenge` and returns
to the invite screen. Markup changed in `web/index.html`; the stale state-list
comment at `web/app.js:9` now matches `web/machine.js`.

Verified on the phone: `npm run unit` 218/218 (up from 214), `go test ./...` ok,
`npm run links` 411 links 0 broken, `gofmt`/`go vet` clean. The new client tests
in `web/app.challenge.test.cjs` (created link shown; search cancels then queues;
full-URL and bare-token claims; empty paste posts nothing; reconnect rebuild;
Play Again re-mints) and the retargeted `web/app.lobby.test.cjs` online cases all
fail against the pre-change `app.js` (the create path posted `/queue`, there was
no `#btn-search`/`#btn-claim`, and `#btn-challenge` existed). Rendering is
hand-checked only: `npm run e2e` is laptop-only (Chromium).

