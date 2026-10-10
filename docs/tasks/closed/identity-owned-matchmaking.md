# Matchmaking state owned by the player, not the connection

Re-key the challenge/reservation to the player registry so a shared invite
survives a dropped stream, a reload, and a second tab — the primitive
[matchmaking-share-code-overhaul](../../issues/matchmaking-share-code-overhaul.md)
waits on.

## Required context

- The challenge maps are keyed by connection id (`h.challenge[c.id]`,
  `server.go:1308-1310`), and `removeClient` deletes the reservation on any
  disconnect (`server.go:516-522`). A backgrounded phone therefore kills a shared
  link, and each tab is an independent client.
- The self-join guard is same-connection only (`server.go:1355`), so a second tab
  can claim the first tab's own code.
- The player registry and its `pid` are specified in
  [identity-registry](../closed/identity-registry.md).
- The token lifecycle is pinned by `challenge_test.go`; keep its contract.

## Constraints

- **One open code per player.** A second tab of the same player sees the same
  reservation, not a new one.
- **Disconnect drops the connection, not the player's reservation.** The
  reservation ends by claim, cancel, match end, or (later) a TTL — not because
  one stream closed.
- Wire change is additive; the engine (`round.go`) is untouched.

## Acceptance criteria

- A reservation opened on a player survives one of that player's connections
  dropping, and is still claimable from another connection with the same `pid`.
- A claim from the same player's other connection is rejected as a self-join.
- The existing token contract is preserved: consumed at *match end*, a second
  opener while the match is live gets `409 challenge in play`, and only a join
  after termination gets `404 challenge gone`.
- Negative direction: a player with no open code still gets `404`; a first claim
  still pairs through `makeMatch`/`startMatchLocked` exactly as before.

## Notes

- Device: this is the concurrency-sensitive slice — it touches `h.mu` and
  per-player lookup under it. Prefer the **laptop** for `go test -race`; on the
  phone the ordering is hand-checked and argued in a comment naming `h.mu`, per
  [device-aware-workflow](../../development/device-aware-workflow.md).
- Not in this slice: the invite-screen UX, the Share API, the code format, and
  the "search for anyone" toggle — those are the matchmaking overhaul, not the
  re-key.

## Landed

The challenge maps are keyed by `pid`, not connection id. `challengeEntry` now
holds `creatorPid` (no `*Client`, which would go stale across a drop) and
`handleJoin` resolves the creator through `creatorClientLocked(pid)`, the
live connection that plays. `removeClient` no longer drops the reservation, and
the per-player lookups in `handleQueue`, `handleCancel`, the CPU handler, the
snapshot, and `finishMatch`'s teardown all move to `pid`. The self-join guard is
now `c.pid == ch.creatorPid`, so a second tab can no longer claim the first
tab's own code, and `handleChallenge` returns a player's existing token rather
than minting a second reservation.

Verified to *fail* against the pre-change hub first, with `server.go` checked
out from HEAD: `TestChallengeSurvivesCreatorDisconnect` ("disconnect spent the
reservation"), `TestChallengeSecondTabSharesReservation` (second tab minted a new
token), `TestChallengeSecondTabSelfJoinRefused` (self-join got 200, want 409),
and `TestChallengeClaimPairsWithPlayersLiveConnection` (join got 404, want 200).
The first also carries the negative direction: while the owner has no live
connection the join is `404`, but the reservation is *not* consumed — a reconnect
with the same `pid` still shows `waiting` on the same token. `go test ./...` ok
on the phone (207s); `npm run unit` 214/214; `npm run links` 402 links, 0 broken;
`gofmt -l .` and `go vet ./...` clean.

`TestChallengeDisconnectSpendsTheLink` was rewritten to this contract (a
disconnect no longer spends the link) and `TestChallengeJoinReturns404WhenGone`
was made deterministic by removing the connection directly instead of racing the
network close's reap.

Not verified here: `go test -race` (refuses on `android/arm64`). The touched
shared state is `h.challenge` / `h.challenges`, both read and written only under
`h.mu` (including `creatorClientLocked`, which iterates `h.clients` under the
same lock), so no lock ordering changed. `npm run e2e` needs Chromium (laptop).

