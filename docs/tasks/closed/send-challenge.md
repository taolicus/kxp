# Send challenge

A player creates a link that anyone can open to join that specific match
directly, bypassing the global queue. The creator waits with a link to copy and
a cancel; the first person to open it is the other side.

## Why this is no longer gated on player-identity

The gate said "the link has to identify whose match it is pointing at". It does
not have to: a link identifies the **match**, not a player. The creator is a
client with a server-issued id, already bound to the match the link points at,
and the claimant gets an id from its own first `GET /events` exactly as every
player does — anonymous, per-tab, and live for as long as the match is. What
identity would add is accountability across sessions (who minted this, resuming
a wait from another device), which is not a property a link whose life is
measured in minutes needs. Un-gating this is what keeps the primitive out in
front of the consumers that do need it; see
[player-identity](../../issues/player-identity.md).

## Semantics

These are decided, not open:

- **Both players are guests.** There is no host. The creator is assigned slot 0
  automatically; the first claimant is slot 1. Sides are already symmetric in
  the engine — `makeMatch` differs only by the bot check — so slot 0 is an
  ordering choice and nothing else.
- **The link lives while anyone is in it.** From creation until a match exists,
  the token is alive as long as its creator's client is connected: a claimant may
  arrive at any moment, not inside a window. If the creator leaves or cancels,
  nobody is in it and it is consumed.
- **The link is consumed at match termination, by any means.** Once it has
  produced a match, the end of that match is the end of the link: a decided
  series, a `void`, an `opponent-left`, or a ready handshake that times out or
  is abandoned. This is one hook rather than a rule per path, because
  `m.finish()` runs in `run()`'s defer and every termination reaches
  `Hub.finishMatch` — that is where the token is dropped.
- **No takeover.** A second opener while the match is live is told it is in
  play; after termination it is told the challenge is gone.

## Shape

- **`POST /challenge {id}`** → `200 {token}`. Idempotent while one is open, the
  way `POST /queue` is: the same token comes back, so a client that retries
  cannot kill its own link. Creating one dequeues the creator if they were
  queueing — they chose this wait — and `POST /queue` with a challenge open is
  `409 challenge already open`, so a link already shared cannot be killed
  silently by queueing afterwards. Capped like `maxQueue`, rate-limited like
  every other POST.
- **`POST /join {id, token}`** → pairs creator and claimant through the same two
  calls `tryMatch` makes (`makeMatch` then `startMatchLocked`), dequeuing the
  claimant first — they chose this match. `400 not connected` for an id that has
  never opened a stream, `404 challenge gone` for an unknown or consumed token,
  `409 challenge in play` while its match is live, `409 already in a match` for
  either side.
- **The waiting life of a token is bound to its creator**: a disconnect
  (`removeClient`) and an extended `POST /cancel` — the waiting view's existing
  button — both drop it.
- **A challenge match's `requeue` returns false**, so a survivor goes to the
  lobby instead of the global queue. That is the branch a CPU match already
  takes; there is no engine change and no new match phase.

404 is new to an API that otherwise uses 400/409/413/503, and it is deliberate:
this is a lookup of a resource that no longer exists, not a malformed request.

## Client

- **Creator**: a challenge entry in the lobby; on `200` render
  `location.origin + '/?challenge=' + token` with copy and cancel, then
  `transition('queue')` **locally**. The waiting state, its cancel edge and its
  `matched` edge already exist and a challenge reuses them, because a challenge
  is the queue with a scope. No wire change and no machine change.
- **Claimant**: read `location.search` on boot and post `/join` on `connected`,
  **after** the `POST /character` that already happens there, so the fighter is
  set before the match is built. On failure, show a lobby notice and
  `replaceState` the parameter away so a reload cannot loop on a dead token. On
  success the existing `matched` frame carries `lobby → matched`.
- **Hazard**: `connected` re-fires on every reconnect, so the claim must run from
  the lobby only — otherwise a reconnect after pairing posts `/join` into a
  consumed token. It gets a test.

## Build order

1. Server: the token map, both endpoints, consumption in `finishMatch`, the
   disconnect and cancel paths, and the `409` in both directions of the
   queue/challenge exclusion. Tests: one per termination means — decided series,
   `readyTimeout`, `readyAbandon` — each asserting that a `POST /join` then
   answers `404`. That is the test that pins the consumption rule. Plus mint,
   idempotence, claim, re-claim, cancel, disconnect, and the cap. No sleeps:
   drive teardown directly.
2. Client: creator view, claimant join and its failure path, the guard.
3. Probe coverage: read `tools/lib/harness.mjs` and `tools/t8-pvp.mjs` first,
   then extend `t8` with a challenge case — which keeps every doc that
   enumerates `t1`–`t8` true — unless its verdict wording turns out to be
   queue-specific, in which case add `t9` and the entries that name it.
4. Docs with the code: `protocol.md` endpoints, `README.md`, and
   `architecture.md`'s matchmaking section, which is where the reasoning above
   belongs and where it should close with this file's landing commit. Then
   `git mv` this file to `tasks/closed/`.

## Not covered

No rendering coverage on this host, and probes require an origin plus an ops
deploy — `t1` fails on `build.sha` against a local build by design.

## Landed

Step 1 (server): the token map and both endpoints, with consumption moved to
match termination rather than `/join`. A second opener while the link's match is
live now gets `409 challenge in play`, and only a join after termination gets
`404 challenge gone`; a challenge match's `requeue` returns false, so a
cancelled handshake sends the survivor to the lobby rather than the queue.

Step 2 (client): the creator/claimant flow and the claim-once latch the hazard
note called for, pinned by `web/app.challenge.test.cjs`. That test needed the
harness to supply `URLSearchParams`, which a vm context does not inherit —
without it the claim path threw inside its own try/catch and no test could reach
it at all.

Step 3 (probe): `t8` scenario C mints, claims, asserts `409 challenge in play`
while the match is live and `404 challenge gone` after it ends, so the suite
keeps every doc that enumerates `t1`–`t8` true.

Step 4 (docs): `protocol.md` endpoints, `README.md`, and the `architecture.md`
matchmaking paragraph this file's rationale closes into.

Verified: `challenge_test.go` covers second-opener-while-live and one test per
termination means (a decided series, `readyTimeout`, `readyAbandon`), plus mint
idempotence, the queue/challenge exclusion in both directions, cancel,
disconnect, and the cap. The new tests were checked to *fail* against the
pre-change handler — the second opener read `404` where it now reads `409`, and
the abandon case left the survivor queued — so they pin the consumption rule,
not just its happy path. `go test ./...` ok, `npm run unit` 194/194,
`gofmt`/`vet` clean, `npm run links` 0 broken.

Not verified here: the probe was validated against a local boot, not the
deployed origin, so `npm run tall` cannot judge it until the ops deploy lands.

