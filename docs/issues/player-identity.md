# Which player-identity model should the server use?

An open decision, not an observed symptom: several features need a shared player
identity and none can be specified without it, but the model itself is unchosen.

**Question** — what identifies a player across sessions? A persistent anonymous
ID, an account, or a token.

**Why it is open** — the options have different costs, and the repository has
already committed to one of them in a way that has not been followed through.

- A persistent anonymous ID is the natural fit for this game: no accounts, no
  credential handling, and it is enough for a leaderboard.
- An account implies a registration and credential path the repo has never had,
  and the server is public and unauthenticated.
- A token sits between the two, and needs a rotation and expiry story.

A persistent anonymous ID has been implemented client-side for the arcade ladder
via `localStorage`. That storage is per-browser and per-origin, so it does not
survive a different device — which is exactly the gap a server-side primitive
would close.

**Evidence that would settle it** — none needed; this is a decision, not a
measurement. It needs a decision, recorded, with the ladder's `localStorage`
persistence retrofitted onto whatever is chosen.

**Context that must survive the answer** — these consumers all share the
primitive, so the choice blocks them and they are recorded here as its blast
radius rather than as separate items:

- **Leaderboard** — server-authoritative, with anti-cheat (ignore
  client-submitted timestamps for ranking, cap CPU streaks). A `void`
  connectivity timeout scores like a draw, never a loss.
- **Lobby / rooms** — private room creation, joining, discovery, access control.
- **Tournament** — bracket/round structure for multi-match competition.

Deciding this first is what keeps those three from each inventing its own notion
of a player.

**Prospective fix (not scheduled)** — this gates four tasks rather than being one
of them: the three above, plus [player-names](../tasks/open/player-names.md).
The rest of Phase 4 does not wait on it, and each says why in its own file:
[solo-campaign](../tasks/open/solo-campaign.md) persists to `localStorage` like
the arcade ladder and will be retrofitted onto whatever is chosen here, and
[match-history](../tasks/closed/match-history.md) is a local record that carries no
rank. [send-challenge](../tasks/closed/send-challenge.md) has already landed
without one, for the same reason: a link identifies a match rather than a
player.