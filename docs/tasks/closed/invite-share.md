# Invite: share through the browser

The invite screen hands the player a link to send a friend. On a phone that
should be the browser's Share API, not a copy button, with Copy as the fallback
where Share is absent or dismissed.

## Required context

- Sharing today is `document.execCommand('copy')` only (`web/app.js:1646-1652`);
  there is no `navigator.share` or `navigator.clipboard` anywhere in `app.js`.
- The invite screen and its link live in [invite-first-entry](../closed/invite-first-entry.md).
- The client test harness stubs a context at `web/appHarness.cjs:121` but no
  `navigator.share`/`clipboard`, so those stubs land with this slice.

## Constraints

- **Additive and defensive.** Absent, insecure context, or a dismissed share
  must fall back to Copy, never throw into the flow.
- No new wire surface; the value shared is the invite URL.

## Acceptance criteria

- A Share control calls `navigator.share` with the invite URL when present.
- Where `navigator.share` is absent or rejects (cancel), Copy still works and
  nothing throws.
- Tests: share called with the URL; fallback path; dismissal does not surface an
  error frame.

## Notes

- Device: client-only, `node --test` on the phone; a real share sheet is
  hand-checked (`npm run e2e` is laptop-only).

## Landed

The invite screen now offers **Share** beside **Copy**. Share calls
`navigator.share({title, text, url})` when the browser has it, and falls back to
a clipboard copy when the API is absent, throws (insecure context), or rejects
(a dismissed sheet) — the promise's `.catch` is what keeps a cancellation out of
the error beacon. Where there is no share sheet the Share button hides itself, so
Copy is the whole of the control on those hosts; `copyInvite` backs both.

The shared harness (`web/appHarness.cjs`) gained a `navigator.share` stub, a
recording `document.execCommand`, and a `select()` on stubbed elements — without
that last one every copy fell into the catch and a fallback test could never see
it. Verified on the phone: `npm run unit` 221/221, `go test ./...` ok,
`npm run links` 0 broken, `gofmt`/`go vet` clean. The three new
`web/app.challenge.test.cjs` cases (share hands over the URL; no-sheet copies;
dismissal copies) fail against the pre-change `app.js`, which had no `#btn-share`
and only an inline copy handler. A real share sheet is not run here — it is
hand-checked, and `npm run e2e` is laptop-only.

