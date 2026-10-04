# Background assets

How the animated match backgrounds are produced and wired into the client.

## Naming scheme

Each stage is a family under `web/img/bg/<name>`:

- `<name>.webp` — the animated background (applied via CSS `--bg-anim`).
- `<name>-static.webp` — a single reduced-motion frame (applied via
  `--bg-static` for `prefers-reduced-motion`).
- `<name>.gif` — the editable source master for regenerating the WebPs.

## Inventory

| Name   | Dims | Frames | WebP | Static | GIF |
|--------|------|--------|------|--------|-----|
| pool   | 799x242 | 58 | 356K | 40K | 272K |
| forest | 639x480 | 19 | 408K | 40K | 688K |
| tomb   | 639x480 | 160 (every 4th) | 824K | 40K | 1.4M |
| arena  | 636x479 | 27 | 636K | 44K | 944K |
| portal | 636x479 | 54 (every 2nd) | 528K | 24K | 1.3M |

Tomb and portal used `WEBP_QUALITY=65` for their animated WebPs.

## Selection

The **server** picks the stage, once per match, and announces it on `matched` as
a `background` name. The client never chooses and never receives bytes: the
WebPs stay client-side assets, and only the name travels. `pickBackground()`
draws from the `backgrounds` roster in `server.go`, and `makeMatch` calls it once
per match rather than once per side — both players are meant to be looking at the
same arena, and a per-side pick would leave two correct-looking screens disagreeing
for reasons neither player could see.

The client still keeps its own `BGS` roster in `app.js`, for two reasons: it is the
fallback when the server's name is missing or unrecognised, and
`TestBackgroundRosterMatchesTheClient` reads both lists and fails if they drift,
because a server-side entry with no client-side counterpart is exactly how the two
lists would silently stop agreeing.

`setBg(d)` resolves the name and applies it, setting the `--bg-anim`/`--bg-static`
CSS variables once the stage has decoded. It replaces `randomizeBg()`, which both
decided and applied; separating the two is what let the decode become a precondition
for the readiness ack (see below) rather than a side effect of showing the screen.

**The stage is a precondition for acknowledging the match, not a decoration on it.**
`setBg` runs before the ack is armed and `armReadyLoop` chains onto `bgReady`, so
`POST /ready` waits for the stage to decode *and* for a presented frame. The
sequencing is the point rather than a detail: `requestAnimationFrame` fires on the
next paint of whatever is on screen, so an ack armed before the image resolved would
be proving a frame of the queue view, not of the match screen — the countdown could
begin with the fight not yet drawn. A stage that fails to load still acknowledges,
because the server's handshake timeout would otherwise cancel the match and cost the
player the round over a background.

The name rides on the `connected` snapshot as well as on `matched`. A client that
reconnects mid-handshake arrives straight at `snapshot:matched` and never sees
`matched`, so without the field it would fall back to its own pick and land in a
different arena than its opponent — the one outcome a shared stage exists to
prevent.

→ rationale: [client consumes the announced stage](../tasks/closed/client-uses-announced-background.md)

## Pipeline

`tools/gen-ani-bg.sh` regenerates the WebPs from a source GIF placed in the
gitignored `web/img/sources/` directory.

- Knobs (env overrides): `MAX_SOURCE_FRAMES`, `SAMPLE_FPS`, `SAMPLE_STEP`,
  `WEBP_QUALITY`.
- Auto-sampling kicks in above 90 source frames; `SAMPLE_STEP` also forces
  sampling below that threshold. Loop duration is preserved.
- The script does no `fps` normalization (that trimmed the loop tail);
  encoders preserve the source's variable frame delays exactly.
- The executable bit can't be set on external storage (Android); run with
  `bash tools/gen-ani-bg.sh`.