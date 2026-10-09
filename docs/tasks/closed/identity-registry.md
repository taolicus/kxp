# Player identity registry

Give the server a per-player record that outlives a connection, so later state
(matchmaking reservations, ladder progress, rooms) can be keyed to a player
rather than to the SSE stream.

## Required context

- `handleEvents` already accepts `?id=` and `getOrCreate` reuses a `Client` for a
  valid id (`server.go:351`, `:270-302`; `validID` at `:304`). That id is the
  **connection**: the `connID` freshness rule (`server.go:459`, `:494`) makes a
  newer stream replace an older one, so it cannot also be a shared, cross-tab
  player.
- The client never persists its id today: `id` begins `null` and is set only
  from the snapshot (`web/app.js:4`, `:1344`, `:1350`), so a reload already mints
  a fresh connection.
- The identity decision and its blast radius are in
  [player-identity](../../issues/player-identity.md).

## Constraints

- The id is **server-issued**, preserving "anonymous clients receive
  server-issued random IDs"; it identifies, it does not authenticate.
- The wire change is **additive**: a client that presents no `pid` behaves
  exactly as today and receives a fresh one.
- Multiple connections may share one `pid` (two tabs). The connection id and the
  `connID` freshness rule are unchanged; a second tab must not reap the first.
- The engine (`round.go`) is untouched; this is hub/server/client only.

## Acceptance criteria

- A connection presenting a known `pid` reattaches to the same player; an absent
  or invalid one mints and registers a new player.
- The snapshot carries `pid`; the client persists it (`localStorage`) and
  presents it on the next connect.
- Two connections with the same `pid` coexist under distinct connection ids.
- Tests: reconnect keeps the `pid`; a fresh browser gets a new one; a missing
  `pid` mints a fresh connection exactly as before (the negative direction).

## Notes

- Device: the server change touches `h.mu` lightly; the multi-tab case is a
  behaviour pinned by a test rather than a race two goroutines must be raced, so
  the phone can carry it. Move to the laptop if the registry ends up under
  concurrent access the test cannot drive directly.
- Not in this slice: a TTL for a stale `pid` and its state. Nothing durable is
  keyed to a player yet, so there is nothing to expire.

## Landed

`handleEvents` now passes `?pid=` alongside `?id=`. `getOrCreate(id, pid)`
resolves the player in `Hub.players` (keyed by the pid) while the connection
keeps its own `id`, so the two-tab and reload cases share a player under
distinct connections. `resolvePlayerLocked` reattaches only a pid the server
previously issued and otherwise mints and registers a fresh one — a client
cannot choose its own identity. The registry is bounded (`maxPlayers`, FIFO
eviction); nothing durable is keyed to a player, so an evicted browser just gets
a new pid. The snapshot carries `pid`, and the client stores it under `kxp-pid`
and presents it on the next `connect()`.

Verified to *fail* against the pre-change code first: the four `TestEvents*`
identity tests failed on a missing `pid` (and the client test failed with
`actual: '/events'` and `actual: null` for the stored pid) before the change,
then passed. `go test ./...` ok on the phone (202s); `npm run unit` 214/214;
`npm run links` 125 documents, 399 links, 0 broken; `gofmt -l .` clean.
`TestEventsReattachesKnownPlayerID` pins both the reattach and the distinct
connection ids; `TestEventsHonorsConnectionID` is the negative direction — a
presented id with no pid is reused exactly as before. `-race` cannot run on this
host, so the `h.mu`-held registry is hand-argued: `resolvePlayerLocked` is only
called under `h.mu` (from `getOrCreate`), and the bound test drives it directly.

Not verified here: `npm run e2e` (needs Chromium, laptop only) — the client
persistence path is covered by `web/app.identity.test.cjs` against the real
`app.js` source instead.

