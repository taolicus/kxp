---
phase: 4
depends-on: [invite-first-entry]
gated-on: []
---

# Invite: share through the browser

The invite screen hands the player a link to send a friend. On a phone that
should be the browser's Share API, not a copy button, with Copy as the fallback
where Share is absent or dismissed.

## Required context

- Sharing today is `document.execCommand('copy')` only (`web/app.js:1646-1652`);
  there is no `navigator.share` or `navigator.clipboard` anywhere in `app.js`.
- The invite screen and its link live in [invite-first-entry](invite-first-entry.md).
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
