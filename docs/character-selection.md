# Character Selection

A purely cosmetic feature: each player picks a fighter from a fixed roster. The
choice has **no gameplay effect** — it only appears on the game screen (your slot,
the opponent slot, and the result line).

## Design

- Roster is data-driven so fighters can be added over time (see
  [Adding a fighter](#adding-a-fighter)).
- Characters are identified by a stable `id` string.
- Your selection is persisted in `localStorage` (`kxp-character`) and pushed to
  the server (`POST /character`) so your opponent can see it in the `result`
  event. The server defaults to the first fighter in the roster if none was set.
- The CPU picks a random fighter per match, server-side.
- Roster lives only on the server:
  - `characters.go` — the source of truth (id, name, emoji), served to the
    client by `GET /characters` and used for validation + CPU random pick.
  - `web/characters.js` — fetches that roster at startup (`loadRoster`) and
    renders the picker; it no longer bundles its own copy. Fighter art is
    placeholder emoji for now; the `emoji` field will be swapped for real
    artwork later. Placeholder roster (ids match display names): Dragon Chino
    (🦂), Sombrero Loco (🔥), Lentes de Sol (🕶️), Lagartijo (🎩), Hielito
    (🪭), Cambiaformas (🦷), Fabulosa (🦎), Robok (🧊), Rafaela (💪),
    Bicho Raro (🗡️), Alakran (🧙), Rayito (💨) — the 12 fighters of the
    original MKII 1992 roster, shown in a 4×3 grid.

## Data flow

1. Player clicks a fighter in the lobby picker.
2. Client stores `kxp-character` in `localStorage` and sends
   `POST /character { id, character }`.
3. Server validates the id and stores it on the `Client`.
4. On client reconnect the selection is re-sent so the server stays in sync.
5. When a match starts, the server includes the opponent's fighter id in the
   `matched` and `result` events (`opponentCharacter`, plus `youCharacter` in
   `result`).
6. The client renders avatars/names from those ids.

## Server changes

- `characters.go` (new): `Character{id, name}` roster (3 fighters), plus
  `validCharacter`, `randomCharacterID`, and a default.
- `server.go`:
  - `Client.character` field (default = first roster fighter).
  - `handleCharacter` handler for `POST /character`.
  - Bot `side` gets a random character when a CPU match is created.
- `round.go`:
  - `matched` event gains `opponentCharacter`.
  - `result` event gains `youCharacter` and `opponentCharacter`.
- `main.go`: register the `/character` route.

## Client changes

- `web/characters.js` (new): fetches the roster from `GET /characters`
  (`loadRoster`), then provides helpers (`characterByID`, `saveCharacter`,
  `loadCharacter`).
- `web/index.html`: "Choose your fighter" picker in the lobby; a VS bar on the
  game screen with your slot and the opponent slot.
- `web/app.js`: render/handle picker, persist + POST selection, re-POST on
  reconnect, render fighter slots from events.
- `web/style.css`: picker grid, selected highlight, avatar styles.

## Default / edge behaviour

- No selection yet → first roster fighter is used.
- CPU: random fighter per match.
- Changing fighter mid-queue is allowed; applies to the next match.
- Unknown/invalid character id → rejected by the server.

## Adding a fighter

1. Add `Character{id, name, emoji}` to the roster in `characters.go`.
2. Done — the picker, validation, and CPU randomiser pick it up automatically
   (the client loads the roster from `GET /characters`, so there is no second
   copy to update).

## Out of scope

- Gameplay effects, stats, and balance.
- Fighters on the lobby and queue screens.
- Global roster syncing (the client fetches the roster from the server, so
  there is a single source of truth).