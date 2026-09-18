# WIP — compress game background (deadpool stage gif)

## Goal
Replace the 6.9 MB `web/img/bg/mk2-stage-the-deadpool.gif` (committed but never
pushed) with lightweight variants + a reusable compression script. Keep the
animation as a game-screen background, commit only lightweight artifacts.

## Current state
- `a5ab592` holds the 6.9 MB gif, NOT on origin (push timed out / aborted).
  It also added `body.in-game` toggle in app.js and the background CSS.
- Destroying the commit loses both files' changes — must re-apply.

## Facts about the source gif
- GIF89a, 799x242 px (3.3:1 landscape banner), 256 colors.
- 58 frames, ~8.6 s loop, variable delays, avg ~6.7 fps, 6.66 MB.

## Steps
1. Preserve source: `mkdir -p web/img/sources && cp web/img/bg/mk2-stage-the-deadpool.gif web/img/sources/`
2. Destroy unpushed commit: `git reset --hard HEAD~1` (back to `ca6cf36`)
3. Gitignore: add `web/img/sources/` to `.gitignore`
4. Create `tools/gen-ani-bg.sh` (chmod +x):
   - Usage: `gen-ani-bg.sh <input.gif> [outdir] [name]`
   - Outputs: `name.webp` (animated), `name-static.webp` (static), `name.gif` (compressed)
   - Prefers ffmpeg (needs libwebp_anim); falls back to gifsicle for gif variant
   - Reports file sizes; exits 1 with install hints if a tool is missing
   - Commands:
     - WebP: `ffmpeg -y -i in -vf "fps=8" -c:v libwebp_anim -lossless 0 -compression_level 6 -quality 75 -loop 0 out.webp`
     - Static: `ffmpeg -y -i in -vf "select=eq(n\\,0)" -vframes 1 -c:v libwebp -lossless 0 -quality 75 out-static.webp`
     - Gif (gifsicle): `gifsicle -O3 --colors 128 in -o out.gif`
     - Gif (ffmpeg fallback): palettegen max_colors=128 + paletteuse dither=sierra2_4a, fps=8
5. Run: `tools/gen-ani-bg.sh web/img/sources/mk2-stage-the-deadpool.gif web/img/bg mk2`
6. Commit all three variants (only if lightweight)
7. CSS `web/style.css`: `body.in-game` background-image -> url('/img/bg/mk2.webp');
   add `@media (prefers-reduced-motion: reduce)` swapping to `mk2-static.webp`;
   keep the dark gradient overlay in both cases
8. Re-apply `app.js` `body.in-game` toggle in `show()`:
   ```js
   document.body.classList.toggle('in-game', view === 'game');
   ```
9. Verify: `node --check web/app.js web/machine.js`, `node --test web/machine.test.cjs`,
   `gofmt -l . && go vet ./... && go build ./... && go test ./...`,
   `ls -la web/img/bg/` (sizes)
10. Commit + push (small files now, should be fast)

## Notes / decisions
- "webp video" = animated WebP file, not a <video> element.
- No `fps` normalization in the script: it trimmed the loop tail and altered
  timing. Encoders preserve the source's variable frame delays exactly.
- Exec bit can't be set on external storage; run the script via
  `bash tools/gen-ani-bg.sh`, not `./tools/gen-ani-bg.sh`.
- Animated WebP as CSS background still CPU-decodes per frame; acceptable for a
  dim decorative layer. If jank appears, add optional .webm variant later.
- Phone cover-crop of a 3.3:1 source is soft-blurry; accepted (decorative).
- No resolution tiers (user: "forget about resolution sizes").
- Source images live in gitignored `web/img/sources/`.

## Results (as of build)
- web/img/bg/mk2.webp         356K, 58 frames, infinite loop, 799x242
- web/img/bg/mk2-static.webp   40K
- web/img/bg/mk2.gif           272K, 58 frames, 5.75s (matches source timing)
- Source 6.7M -> ~668K total (~10x reduction)