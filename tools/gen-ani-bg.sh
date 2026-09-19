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

# When the source has more frames than this, sample it down to SAMPLE_FPS so
# the animation stays lightweight (loop duration and delay pattern preserved).
# Deadpool/forest-style loops (<= 90 frames) are left untouched.
MAX_SOURCE_FRAMES="${MAX_SOURCE_FRAMES:-90}"
SAMPLE_FPS="${SAMPLE_FPS:-10}"
SAMPLE_STEP="${SAMPLE_STEP:-0}" # 0 = auto-compute from the two above
WEBP_QUALITY="${WEBP_QUALITY:-75}"

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

# Probe the source: frame count + duration to decide on down-sampling.
if command -v ffprobe >/dev/null 2>&1; then
  SRC_FRAMES="$(ffprobe -v error -select_streams v:0 -count_frames \
    -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$INPUT" 2>/dev/null \
    || echo 0)"
  SRC_DUR="$(ffprobe -v error -select_streams v:0 \
    -show_entries format=duration -of default=nw=1:nk=1 "$INPUT" 2>/dev/null \
    || echo 0)"
else
  SRC_FRAMES=0
  SRC_DUR=0
fi

VF_SAMPLE=""
VF_ARGS=()
if [ "${SRC_FRAMES:-0}" -gt "$MAX_SOURCE_FRAMES" ] || [ "${SAMPLE_STEP:-0}" -gt 1 ]; then
  if [ "${SAMPLE_STEP:-0}" -gt 1 ]; then
    STEP="$SAMPLE_STEP"
  else
    STEP="$(awk -v f="$SRC_FRAMES" -v t="$SAMPLE_FPS" -v d="$SRC_DUR" \
      'BEGIN { fps = d > 0 ? f / d : 0; s = fps > t ? int(fps / t + 0.5) : 1; print (s >= 1 ? s : 1) }')"
  fi
  if [ "$STEP" -gt 1 ]; then
    echo "  note: source has $SRC_FRAMES frames (~$(awk -v f="$SRC_FRAMES" -v d="$SRC_DUR" 'BEGIN { print (d > 0 ? f / d : 0) }')fps); sampling every ${STEP}th frame to ~$(awk -v f="$SRC_FRAMES" -v s="$STEP" -v d="$SRC_DUR" 'BEGIN { print (d > 0 ? f / s / d : 0) }')fps (duration preserved)"
    VF_SAMPLE="select=not(mod(n\\,$STEP)),"
    VF_ARGS=( -vf "${VF_SAMPLE}" )
  fi
fi

echo "  -> animated webp ($OUTDIR/$NAME.webp)"
ffmpeg -y -loglevel error -i "$INPUT" \
  "${VF_ARGS[@]}" \
  -c:v libwebp_anim -lossless 0 -compression_level 6 -quality "$WEBP_QUALITY" \
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
    -vf "${VF_SAMPLE}split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[pal];[b][pal]paletteuse=dither=sierra2_4a" \
    "$OUTDIR/$NAME.gif"
fi

echo
echo "== results =="
du -h "$OUTDIR/$NAME.webp" "$OUTDIR/$NAME-static.webp" "$OUTDIR/$NAME.gif" "$INPUT"