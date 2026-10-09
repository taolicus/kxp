# A challenge wait survives reconnect

A player who has created a challenge link holds no state the reconnect snapshot
recognises. `Hub.snapshot` starts every client `idle` and only upgrades to a
waiting state for `c.queueing` (server.go:559, 591), but a challenge waiter is
not queued — the entry lives in `h.challenges` and `handleChallenge` never sets
`c.queueing`. So an SSE reconnect (a dropped radio, a stall-watchdog trip)
snapshots the creator as `idle`, the client's `snapshot:idle` edge walks it to
the lobby, and the link disappears from the screen. The challenge itself is
still live: re-pressing Create Challenge re-mints the same token
(`handleChallenge` is idempotent while the entry is open), so the wait is
recoverable — but the shared link is gone from the screen until the player
notices and presses again.

Not gated on [player-identity](../../issues/player-identity.md): it is a fix to the
landed [send-challenge](../../tasks/closed/send-challenge.md), and needs no
identity for the same reason that feature did not — a link identifies a match,
not a player.

## Steps

- **Server.** In `snapshot`, add a branch beside `c.match` and `c.queueing`: a
  client holding an open challenge gets `"state": "waiting"` and the entry's
  token in a new field. The field is additive, so an existing client drops it
  and falls back to today's lobby reading rather than breaking.
- **Client.** On a `connected` frame whose snapshot carries the token, refill
  `#challenge-url`, set `challengePending`, and transition to the waiting screen.
  The token then survives a full page reload, not only an SSE reconnect.

## Acceptance criteria

- A creator who reconnects (or reloads) while waiting lands back on the queue
  screen with the same link, and a later `/join` still pairs the two clients.
- A server test pins the snapshot state and token for a challenge waiter.
- A client test pins that a `connected` frame carrying the token re-renders the
  link, and that a frame without one still falls to the lobby.
- The `?challenge=` claimant path is unaffected: it still claims once per load.

## Not covered

No rendering coverage on this host, and the probes verify frames rather than the
focus a reload restores — the client half rides the app-harness test.

## Landed

The snapshot now carries a challenge waiter's token: `snapshot` gained a branch
beside `c.match` and `c.queueing` that reads `h.challenge[c.id]` under `h.mu`
and emits `state: waiting` with `challenge: <token>`. The client rebuilds the
link from that field before routing the snapshot, so a plain queue wait stays
`waiting` with no `challenge`.

This covers the reconnect that keeps the same client — `getOrCreate` returns the
existing one, and the old stream's `endConn` no-ops once `beginConn` has moved
the connection id on (server.go:494-503), so the challenge is still open when the
new snapshot is taken. A true disconnect still spends the link (`removeClient`),
and then the snapshot is `idle` and the lobby is the right place to land — the
fix does not, and must not, resurrect a spent link.

Verified: `TestChallengeWaitSurvivesReconnect` pins the state and token, and
`TestQueueSnapshotCarriesNoChallenge` pins the negative (a queued client is
`waiting` with no `challenge`). Both were checked against the pre-change code:
the first read `idle` where it now reads `waiting`, and the second guards the new
branch from over-reaching. On the client, "a reconnect carrying the link token
rebuilds the queue screen" and "a plain waiting snapshot shows no challenge link"
run the real `app.js`; the first was checked to fail with the pre-change source.
`go test ./...` ok, `npm run unit` 198/198, `gofmt`/`vet` clean, `npm run links`
0 broken. `protocol.md` documents the new `challenge?` field.
