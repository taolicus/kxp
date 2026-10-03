---
phase: 3
depends-on: []
gated-on: []
---

# Character roster & portraits

Cosmetic expansion of the fighter roster. Data lives in `characters.go` +
`web/characters.js`; no wire change, no gameplay effect.

- Real art at `/img/char/<id>.webp`, with an emoji fallback (`img.art.missing`).
- `tools/gen-char.sh` converts user-supplied sources from `web/img/sources/char/`
  (gitignored).
- Select-screen polish: thumbnails, selected ring, hover.
