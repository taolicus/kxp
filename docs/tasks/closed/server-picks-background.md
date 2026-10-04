# Server picks the background; assets stay client-side

The match stage is chosen by the server and announced on `matched` as a
`background` name. The assets never leave the client — the animated and
reduced-motion WebPs are fetched by the browser as they always were — so the wire
carries one short string and nothing else. This is the "preparing" work in
[preparing-phase.md](preparing-phase.md) completed: choosing the stage is one of
the things that happens before the countdown is allowed to start.

**One choice per match, not per side.** This is the part worth stating, because
the per-side version would look correct in every screenshot. `makeMatch` calls
`pickBackground()` once and stores it on the match; both sides are handed the same
value from there. Had it been picked in the `matched` send loop, the two players
would see different arenas with nothing on either screen to say so.

**The two rosters are pinned to each other.** `backgrounds` in `server.go` and
`BGS` in `app.js` have to agree, because a client handed a name it does not
recognise has to fall back to picking for itself — and that is precisely how the
two players would start seeing different stages while both screens looked right.
`TestBackgroundRosterMatchesTheClient` parses `app.js` and compares, so adding a
stage in one place and forgetting the other fails the suite rather than shipping.
The client keeps `BGS` for that fallback and for the drift check itself; it is not
authoritative any more.

`randomizeBg()` keeps its name and its job — it is still what applies the stage by
setting `--bg-anim`/`--bg-static` — but it no longer decides which stage. The
client consuming the announced name is the remaining half and is not started here.

→ rationale: [backgrounds.md#selection](../../features/backgrounds.md#selection)