# Random fight backgrounds

Each match picks one of five stages at random. Implemented client-side: `app.js`
keeps a `BGS` roster and `randomizeBg()` sets `--bg-anim`/`--bg-static` on the
document (the animated WebP plus its reduced-motion static frame), so the stage
changes between fights with no server round-trip.
