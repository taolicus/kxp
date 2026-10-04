# The client uses the announced stage, and the stage gates the ack

The second half of the server-owned background: `app.js` reads the name off
`matched`, applies that stage, and stops choosing for itself. `setBg(d)` replaces
`randomizeBg()`, which used to decide *and* apply — splitting those two is what made
the decode a condition of the ack instead of a side effect of showing the screen.

**The bug this fixed was in the sequencing, not the stage.** `showGame()` already
waited for the background to decode, but `armReadyLoop()` waited only for a
presented frame, and the two were never sequenced. `requestAnimationFrame` fires on
the next paint of *whatever* is on screen, so with a two-second background the frame
gate opened while the client was still showing the queue view: the ack went out, the
handshake completed, and the countdown began with the match screen not yet drawn —
the precise failure the background work existed to remove. Arming the ack behind
`bgReady` is one chain in `armReadyLoop`, and it also closes a related hole: the
frame being waited on is now a frame of the game screen rather than of whichever
view happened to be up. `TestTheAckWaitsForTheAnnouncedBackgroundToLoad` pins both
halves — no ack and *no armed frame* until the image resolves — and was checked to
fail against the un-chained version, where the ack landed before the stage was even
requested.

**The fallback is the additive case, and it is deliberate.** A client trusts the
server's name only if it recognises it; anything else — an old server that never
sends the field, or a roster that has drifted — falls back to a local pick. A
client that trusted an unknown name would request an asset it does not have and
bring the game screen up unpainted, so guessing is strictly better than obedience
here. That fallback is also why the two rosters have to be pinned to each other:
see [server-picks-background](server-picks-background.md) and the drift guard
between them. It is also why `BGS` is read out of `app.js` by the test harness
rather than restated in the tests — a third literal would be another list to forget.

**A failed asset still acknowledges.** A 404 on the stage defers nothing. The
alternative is worse than a missing background: the server's handshake timeout would
cancel the match, turning a cosmetic failure into a lost round.

**Reconnect needed the field too.** A client that reconnects mid-handshake arrives
straight at `snapshot:matched` and never sees `matched`, so the stage rides on the
`connected` snapshot as well. Without it the reconnected player would fall back to
its own pick and be dropped into a different arena than its opponent — the single
outcome a shared stage exists to prevent, and one no test on the happy path would
ever have shown.

Verified: `npm run unit` (11 tests in `web/app.ready.test.cjs`, up from 6),
`node --check` on both files, and the Go suite for the new snapshot field. Each new
test was checked to fail against the mistake it guards — an ack not chained to the
decode, an unknown name trusted, and the server's choice ignored in favour of a
local pick each fail with the assertion that describes them.

Not verifiable on this host: that the stage appears on a real device, and the
wall-clock cost of waiting for the image before the ack. The second one is a real
trade rather than a proof — a client on a slow link now spends longer in `preparing`
before acknowledging, and the handshake timeout is what bounds it.

→ rationale: [backgrounds.md#selection](../../features/backgrounds.md#selection), [architecture.md](../../features/architecture.md)