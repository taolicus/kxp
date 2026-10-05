# Character roster

Who is playable. This list is the roster: `characters.go` holds these fighters in
this order, `GET /characters` serves them, and the lobby picker, the CPU's random
pick, and every [arcade ladder](../tasks/closed/arcade-ladder.md) floor are drawn
from it.

## How the list lands

- **The first entry is the default.** A client that has chosen nothing — or whose
  stored choice is no longer here — gets it (`defaultCharacterID`, and the
  fallback in `web/characters.js`).
- **The `id` is the name, slugged:** lowercase, spaces hyphenated, accents folded,
  so `juan-cajeta`, `ko-shi-nin`, `hielitalo`. The id is what a client keeps in
  `localStorage`, what a ladder floor names the bot by, and what
  `validCharacter` recognises — the one field that has to be spelled the same way
  everywhere it appears.
- **Renaming a fighter makes a new one.** A stored `kxp-character` for a name that
  has left the list falls back to the default, and a saved ladder whose fighters
  have all left it is read as a run in progress (`readArcade` in `web/app.js`).
  Carrying the old ids onto the new names instead would put an id on the wire and
  in stored ladders that names nothing.
- **Cosmetics only.** A fighter is an id, a name, and one emoji; nothing reads a
  fighter for anything except drawing it. The picker, the `POST /character`
  round-trip, and how a selection reaches the opponent's slot are in
  [character selection](character-selection.md).
- **The client's tests carry their own invented roster** (`web/app.arcade.test.cjs`),
  so a name appearing in a test does not mean it is playable.

## Playable

- 🕶️ Juan Cajeta
- 🔴 Kamo
- ⚡ Ema
- 🐉 Taolikus
- 🦂 Lucio
- 🧊 Hielítalo
- 🗡️ Ko Shi Nin

## Bosses

- 👹 Tubipapilla
- 🔮 Tu Papá

Named here and deliberately **not** in the roster: `GET /characters` is also the
ladder's floor list, so a boss in the roster would put a boss on every ladder.
A boss belongs on the final floor of the [solo campaign](../tasks/open/solo-campaign.md),
which is the one piece that build left out of the ladder — and not being a roster
fighter is the point of it. The ladder is made of the others; the last floor is
the one that is not.
