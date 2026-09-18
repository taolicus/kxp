#!/usr/bin/env bash
#
# gen-ani-bg.sh — generate lightweight variants of an input GIF.
#
# Usage: gen-ani-bg.sh <input.gif> [outdir] [name]
#   outdir   default: web/img/bg (relative to repo root)
#   name     default: basename of input without extension
#
# Outputs (in outdir):
#   <name>.webp          animated WebP (primary animated background)
#   <name>-static.webp   static WebP, first frame (reduced-motion/fallback)
#   <name>.gif           compressed animated GIF (legacy fallback)
#
# Requirements: ffmpeg with libwebp_anim and gif encoders
#               (optional: gifsicle for a tighter GIF variant)

set -eu

usage() {
  echo "usage: $0 <input.gif> [outdir] [name]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage

INPUT="$1"
OUTDIR="${2:-web/img/bg}"
if [ $# -ge 3 ]; then
  NAME="$3"
else
  NAME="$(basename "$INPUT")"
  NAME="${NAME%.*}"
fi

[ -f "$INPUT" ] || { echo "error: input not found: $INPUT" >&2; exit 1; }
mkdir -p "$OUTDIR"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found. Install it with: pkg install ffmpeg" >&2
  exit 1
fi

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libwebp_anim; then
  echo "error: ffmpeg lacks libwebp_anim encoder; the webp variants need it." >&2
  exit 1
fi

echo "== generating variants for $INPUT =="

echo "  -> animated webp ($OUTDIR/$NAME.webp)"
ffmpeg -y -loglevel error -i "$INPUT" \
  -c:v libwebp_anim -lossless 0 -compression_level 6 -quality 75 \
  -loop 0 "$OUTDIR/$NAME.webp"

echo "  -> static webp ($OUTDIR/$NAME-static.webp)"
ffmpeg -y -loglevel error -i "$INPUT" \
  -vf "select=eq(n\\,0)" -vframes 1 \
  -c:v libwebp -lossless 0 -quality 75 \
  "$OUTDIR/$NAME-static.webp"

echo "  -> compressed animated gif ($OUTDIR/$NAME.gif)"
if command -v gifsicle >/dev/null 2>&1; then
  gifsicle -O3 --colors 128 "$INPUT" -o "$OUTDIR/$NAME.gif"
else
  ffmpeg -y -loglevel error -i "$INPUT" \
    -vf "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[pal];[b][pal]paletteuse=dither=sierra2_4a" \
    "$OUTDIR/$NAME.gif"
fi

echo
echo "== results =="
du -h "$OUTDIR/$NAME.webp" "$OUTDIR/$NAME-static.webp" "$OUTDIR/$NAME.gif" "$INPUT"