---
phase: 4
depends-on: []
gated-on: []
---

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
