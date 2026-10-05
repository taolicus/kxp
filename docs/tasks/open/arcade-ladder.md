---
phase: 4
depends-on: [game-mode-architecture]
gated-on: []
---

# Arcade ladder

One floor per character, climbed against the stock bot, in a randomised order
with the mirror match last — the arcade original's shape.

## The ladder is the roster, shuffled once per run

Floors come from `GET /characters` — never a list written in the client — so a
roster change reshapes the ladder with no second edit: a character added is a
floor added, one removed is a floor removed. `web/app.js` already fetches the
roster at startup and already derives the character picker from it, so this is
the same rule the lobby follows rather than a new one.

The order is **randomised**, with one exception: the player's own character is
always the **last** floor, the mirror match, whatever the shuffle did. Every
other fighter appears exactly once.

## The order is persisted, because progress is a position in it

A random order means "floor 3" only means something relative to the order that
was drawn, so the order itself is stored — otherwise a reload reshuffles the
ladder under a player who is halfway up it. Stored is `{order, floor, best}`:

- `order` is the draw, the player's own character last. A loss does not redraw:
  climbing the same ladder again is the arcade original's behaviour, and
  redrawing would make "which floor was that" unanswerable.
- `floor` is how far up that order the player is.
- `best` is the high-water mark, a count of floors **cleared** rather than an
  index — the only figure that means the same thing across two different orders,
  which is also why it survives a redraw that the order does not.

What is in `localStorage` is untrusted input: it is writable by hand and outlives
the code that wrote it. A stored run that cannot be read as one — unparseable, not
an object, an order that is not an array, or an order none of whose fighters are
still on the roster — is a first run, and draws a fresh ladder.

## Repairing a stored order against a changed roster

A ladder saved before a roster change is not a valid ladder any more, so it is
repaired on read rather than trusted or thrown away:

1. Keep the stored ids that are still on the roster, in their stored order.
2. Append roster characters the stored order does not mention.
3. The player's own character is removed from wherever it landed and put last.

So a character added mid-run becomes a floor ahead of where the player is, a
character removed takes its floor with it, and the mirror stays last. The floor
index is then clamped to the repaired order's length. Throwing the order away
instead would silently restart a run at the bottom, and trusting it would point a
floor at a fighter that no longer exists.

## Difficulty is the stock bot

Every floor is the same bot: `botAction()`'s 50–350ms reaction and a uniformly
random move, exactly as a plain CPU match. The ladder is a tour of the roster,
not a difficulty curve, so it needs no engine change to the bot and no new
per-match difficulty to validate. Escalating the reaction time per floor is the
obvious next step and is deliberately not here — it would be a game rule the
client asks for, and it should land as its own change rather than ride along
inside a progression feature.

## Losing restarts the ladder

A win advances one floor; a loss puts the player back on the first, as in the
arcade original. Progress moves on the match's **final** result only —
`seriesOver` — never on a mid-series round, which is the whole reason the series
fields exist. Clearing the last floor completes the ladder.

## Persistence is `localStorage`, and is retrofittable

Floor index and high-water mark live in `localStorage`, per-browser and
per-origin. That is what makes this buildable now: server-side progress needs the
identity primitive, which is still an open decision
([player-identity](../../issues/player-identity.md)). This is the recorded debt —
the same debt [solo-campaign](solo-campaign.md) carries — and both get
retrofitted onto whatever that decision is.

## Not in this build

- **A boss floor.** The boss would have to be a character outside the roster,
  and the roster is what the ladder is made of.
- **Endurance match.** Deferred, per the original request.
- **Anything server-side about progression.** The server judges every round; the
  client decides which floor it climbs and remembers how far it got.

## Depends on

[game-mode-architecture](game-mode-architecture.md) — a floor is a CPU match, so
it runs under the mode selector. The CPU half has landed (the series and the
length choice); the PvP half is irrelevant here and stays open on its own.

## The one server change it needed

`POST /cpu` takes `opponentCharacter?`, validated against the roster, so a floor
can be fought against a specific fighter instead of a random one. The client
choosing who it climbs is not a hole: the bot's reaction is fixed, its move is
random, and every round is still judged server-side. There is no ladder state on
the server to cheat, because the ladder *is* the roster and the progress is the
client's own.
