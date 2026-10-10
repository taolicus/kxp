# Player identity: a persistent anonymous browser ID

Several features need a shared player identity and none can be specified without
it. The model is chosen and the primitive is specified as two tasks; what
remains open is how a stale identity and its stored state end.

**The model: a persistent anonymous ID.** A random value the browser keeps in
`localStorage` and presents to the server, which keys per-player state to it
rather than to the SSE connection. No accounts, no credential handling; it
identifies but does not authenticate, so it carries no privilege to rotate.

**Why the alternatives were rejected**

- An account implies a registration and credential path the repo has never had,
  and the server is public and unauthenticated.
- A bearer *token* with a rotation and expiry story is more machinery than a
  nameless game needs.

A persistent anonymous ID is already implemented client-side for the arcade
ladder via `localStorage` (`kxp-stats`, `ARCADE_RUNS_KEY`, `kxp-character`). That
storage is per-browser and per-origin, so it does not survive a different device
— exactly the gap a server-side primitive closes.

**What the model does not cover** — persistence stays per-origin and per-browser:
private mode, cleared site data, and another device each yield a fresh ID, so
anything keyed to it is best-effort and needs a fallback or TTL rather than
relying on the ID alone. Two live connections may share one ID (two tabs), and
the SSE lifecycle's "newer connection survives" rule does not by itself say what
a shared per-player reservation does.

**The contract** — the primitive is built by two landed slices:
[identity-registry](../tasks/closed/identity-registry.md) (a server-issued `pid`
carried on connect, persisted by the browser, and keyed separately from the
connection) and
[identity-owned-matchmaking](../tasks/closed/identity-owned-matchmaking.md)
(matchmaking state owned by the player, not the connection). A client that
presents no `pid` behaves as today and receives a fresh one; two connections may
share one `pid` (two tabs), and the connection id's freshness rule is unchanged.
The ladder's `localStorage` is retrofitted onto it rather than left as a second
copy of identity. Still open: what ends a stale identity and the state keyed to
it (a TTL), which lands with the first thing that owns durable per-player state.

**Context that must survive the answer** — these consumers all share the
primitive, so they are recorded here as its blast radius rather than as separate
items each waiting on the same decision:

- **Leaderboard** — server-authoritative, with anti-cheat (ignore
  client-submitted timestamps for ranking, cap CPU streaks). A `void`
  connectivity timeout scores like a draw, never a loss.
- **Lobby / rooms** — private room creation, joining, discovery, access control.
- **Tournament** — bracket/round structure for multi-match competition.
- **Online match invitations** — the personal-queue reservation keys to the ID
  rather than to the connection, and the ID is what lets the server enforce one
  open code and reject a self-join across tabs; see
  [matchmaking-share-code-overhaul](matchmaking-share-code-overhaul.md).

Choosing one model is what keeps these from each inventing their own notion of a
player.

**Prospective fix (not scheduled)** — [identity-registry](../tasks/closed/identity-registry.md)
built the primitive and [identity-owned-matchmaking](../tasks/closed/identity-owned-matchmaking.md)
re-keyed matchmaking to it, both landed, so the consumers above no longer wait
on anything here: [player-names](../tasks/open/player-names.md),
[leaderboard](../tasks/open/leaderboard.md), [lobby-rooms](../tasks/open/lobby-rooms.md),
and [tournament-model](../tasks/open/tournament-model.md) carry empty
`depends-on` and name the `pid` as the thing they key to; the invite work
([matchmaking-share-code-overhaul](matchmaking-share-code-overhaul.md)) awaits
only its own placement decision. What stays open is the TTL question in the
paragraph above. The rest of Phase 4 never waited on it:
[solo-campaign](../tasks/open/solo-campaign.md) persists to `localStorage` like
the arcade ladder and will be retrofitted onto the primitive, and
[match-history](../tasks/closed/match-history.md) is a local record that carries
no rank. [send-challenge](../tasks/closed/send-challenge.md) landed without one,
for the same reason: a link identifies a match rather than a player.