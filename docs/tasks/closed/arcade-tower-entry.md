# Arcade entry opens on the tower

Choosing **Arcade Mode** now opens the tower — the run's own screen — and the
first floor starts from its Fight button, instead of dropping the player
straight into floor one's match. The tower was previously a screen a player
only ever saw *after* a match; the lobby's one line ("Floor 3 of 4") could not
say the order's shape, who stood on the floor ahead, or that a cleared run was
left at the top.

The reasoning lives where the system does: the tower section of
[architecture.md](../../features/architecture.md#the-tower-is-the-runs-own-screen-not-a-decoration-on-the-result),
which now covers the entry as well as the climb.

## Decided

- **Picker, then tower, then match.** The picker stays first because the run's
  whole shape follows from it: `drawOrder()` puts the picked fighter last as
  the mirror, so the order is drawn after the pick, never before. What changed
  is `#btn-start`'s `ladder` branch — it hands over to the tower instead of
  posting. The tower's Fight button already posts the floor, so the wire and
  the server never moved.
- **Entering saves what it shows.** A first run's order is drawn by
  `readArcade()` and deliberately not saved there (the draw depends on the
  fighter just picked; it cannot happen at lobby time). That was safe when the
  tower was only reachable after `postCPU()` had saved the run; from the lobby
  it is not, because `drawOrder()` shuffles with `Math.random` and the fight
  button would draw a *second* ladder under the player. So `enter.ladder()`
  saves the run it is about to render — a no-op for an existing run, and for a
  first run the moment the order becomes durable, which is what keeps a reload
  mid-tower on the same ladder.
- **One new machine edge**: `lobby` gains `climb`, the same event the result
  screen uses to hand over. The choose view is not a machine state, so the
  machine is in `lobby` when the picker's button is pressed. The tower's edges
  (`matched` out, `mode` back) are unchanged — the request that leaves it is
  an ordinary CPU match either way.
- **`stateIdle` stays ignored on the tower**, with a widened premise: on one
  side the match has just ended, on the other it has not started, and either
  way a teardown frame has nothing to reconcile. Routing it to the lobby would
  walk a player off their own ladder in the old entry and the new one alike.

## Not covered here

- **Rendering** — `web/style.css` and the climb animation still have no
  coverage on this host, and the probes (`t1`–`t8`) verify frames, not
  screens, so a broken entry would be invisible to them.
- **The cleared-run wrinkle**, parked with the UI pass: a completed run enters
  as a completed run — by the save rule above, nothing is reset on the way in —
  so the tower says "Arcade complete" and only the Fight button's request
  draws the fresh order. The player sees the old tower, then the first floor
  of a ladder whose new order they never saw. Moving that redraw into the view
  belongs with the labels and layout, not with this navigation change.

## Verified

- `web/app.arcade.test.cjs`: "the Arcade Mode entry opens on the tower, saving
  the run before anything is fought" (new) and "a cleared arcade says so in
  the lobby, and the entry shows it before its restart" (rewritten) were both
  verified to fail against the pre-change flow, where `#btn-start` posted and
  the tower never showed. The file's `fight()` helper now climbs through the
  tower, and every ladder test starts one.
- `web/machine.test.cjs`: `lobby` + `climb` → `ladder` is pinned (previously
  asserted `null`), and the "not from anywhere else" guard moved from `lobby`
  to the states that genuinely cannot reach the tower.
- No Go code changed, so an entry-going-straight-to-match regression would not
  be caught by `go test`; `npm run unit` (150/150) is the gate.