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

The game screen picks one of the five stages at random per match: `app.js`
keeps a `BGS` roster and `randomizeBg()` sets the `--bg-anim`/`--bg-static`
CSS variables on the document, so the stage changes between fights with no
server round-trip.

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