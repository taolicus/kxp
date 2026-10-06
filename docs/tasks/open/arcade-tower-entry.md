---
phase: 4
depends-on: []
gated-on: []
---

# Arcade entry opens on the tower

Opening **Arcade Ladder** puts the player on the tower with the run they would
resume — its floor, the fighter standing on it, the high-water mark — and the
first floor starts from the tower's own Fight button. Today the button goes
through the fighter picker and then straight into floor 1's match, so the tower
is a screen the player only ever sees *after* a match: they learn where the run
stands at the moment it has stopped standing there.

The lobby already reports one line of it ("Floor 3 of 4"). What it cannot say is
the order's shape, who stands on the floor ahead, or that a cleared run was left
at the top — and all three are already drawn by `showTower()` on a screen that
cannot be reached until a match has decided them.

## Decided

- **Picker, then tower, then match.** The picker stays where it is. It is where
  the run's fighter is chosen, and `drawOrder()` puts that fighter last as the
  mirror, so the run must be drawn *after* the pick rather than before it —
  letting the player change fighter mid-tower would repair the order out from
  under a run already on screen. What changes is what `#btn-start` does with
  mode `ladder`: it opens the tower instead of posting. The tower's Fight button
  already posts the floor, so the wire does not move and neither does the
  server — the request that starts floor 1 is the one that starts it today.
- **Entering saves what it shows.** A first run's order is drawn by
  `readArcade()` and deliberately not saved there, because the draw depends on
  the fighter the player picked in the picker, which is after the lobby is on
  screen. That was safe when the tower was only reachable after `postCPU()` had
  saved the run; from the lobby it is not, because `drawOrder()` shuffles with
  `Math.random` and the fight button would draw a second, different ladder under
  the player. So `enter.ladder()` saves the run it is about to render. For an
  existing run that is a no-op; for a first run it is the moment the order
  becomes durable, which is what makes a reload mid-tower resume the same
  ladder. Nothing is *reset* on the way in: a cleared run still enters as a
  cleared run, and its restart still belongs to the request.
- **One new machine edge**: `lobby` gains `climb`, the same event the result
  screen uses to hand over to the tower. The choose view is not a machine
  state, so the machine is still in `lobby` when the picker's button is
  pressed. The tower's existing edges — `matched` out of it, `mode` back to the
  lobby — are unchanged: the request that leaves it is an ordinary CPU match
  either way.
- **`stateIdle` stays ignored on the tower**, and the premise widens: the tower
  is now reachable with no match in progress at all, so a trailing teardown has
  nothing to reconcile from either direction. Routing it to the lobby would
  walk a player off their own ladder in the old entry and the new one alike.
- **The empty-roster guard comes free.** `enter.ladder()` already routes to the
  lobby when the saved order is empty — a deploy that emptied the roster — and
  `#btn-ladder` is disabled until the roster arrives, so the new path inherits
  both guards rather than needing its own.

## Shape

- `web/app.js` — the `#btn-start` handler branches on `mode === 'ladder'` to
  `transition('climb')` and returns: no request, so no re-arm path on that
  branch beyond what a refused route needs (`btn.disabled = false`,
  `pendingMode` restored). `openChoose`, `showTower`, `#ladder-fight` and
  `#ladder-leave` are untouched, and `enter.ladder()` gains the save above.
  Two comments stop being true and are rewritten with the code: the one above
  `enter.ladder()` ("the tower, between ladder floors … reached from the result
  screen") and the one at the leave handler ("The tower is only reachable from
  a decided floor").
- `web/machine.js` — `lobby: { climb: 'ladder' }`, and the comment on the
  `ladder` state names the lobby as well as the result screen as its origin.
- The request, the run it names, and the frames that answer it do not change,
  so no probe is involved: this is client navigation, which `t1`–`t8` cannot
  see.

## Build order

1. The edge, the branch and the save, in the same commit as the tests in
   `web/app.arcade.test.cjs`:
   - a new test that Arcade Ladder opens on the tower: no `POST /cpu`, the
     saved rows drawn, the fight button armed, and the run **in storage before
     the match starts**. The last claim is the one that fails against a client
     without the save — today nothing is written until the fight button posts,
     so the tower would be showing an order storage has never heard of.
   - the file's `fight(app, 'ladder')` helper gains the tower step
     (`#btn-ladder` → `#btn-start` → `#ladder-fight`), because every ladder
     test in the file starts one.
   - "a cleared ladder says so in the lobby, and the entry starts a new one"
     moves its claim: after `#btn-start` the stored run is still cleared — the
     entry only *shows* it — and the reset to floor 0 happens at
     `#ladder-fight`. Negative direction: the same test still ends with
     `floor: 0` and `cleared: false`, so the redraw cannot be skipped while it
     moves.
   - negative direction for the branch: Play vs CPU must still post from
     `#btn-start`. `fight(app, 'cpu')` in this file and the lobby's own CPU
     test are that pin — the branch is on the mode, not on "the picker".
2. Docs with the code, since they describe the system as it stands:
   - `docs/features/architecture.md`, § The arcade ladder — the paragraph that
     opens "The tower is reached only from a decided floor" (its conclusion,
     why the tower ignores `stateIdle`, survives; its premise becomes "from the
     result screen or from the lobby, neither with a match in progress") and
     the sentence "The new order is still drawn by the request, not by the
     view" (the rule behind it was always *saved before shown*; the entry is
     now the place a first run is both).
   - `docs/features/protocol.md` — the state table's `lobby` row gains
     `climb*`→`ladder`, and the `ladder` bullet names both ways in and drops
     "the match is decided before this state is reachable" for the widened
     reason.
   - `README.md` — the Arcade Ladder bullet says "Between floors you get the
     tower"; it gains the entry, because that sentence is the first thing a
     new player reads about how the mode begins.
   Then `git mv` this file to `docs/tasks/closed/`.

## Not covered

- **Rendering.** This host has no coverage for `web/style.css` or the tower's
  climb animation, and the probes verify frames, not screens.
- **The cleared-run wrinkle**, parked with the UI pass: a completed run enters
  as a completed run — by design, see above — so the tower says "New Ladder"
  and only the fight button's request draws the fresh order. The player sees
  the old tower and then the first floor of a ladder whose new order they never
  saw. Moving that redraw into the view means saving somewhere the player has
  not asked for a match yet, which is now the rule rather than the exception,
  and it belongs with the labels and layout rather than in this navigation
  change.
