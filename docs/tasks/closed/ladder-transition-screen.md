# Ladder transition screen

The tower between ladder floors: the whole order drawn, floor one at the bottom,
with the player standing on the floor the run is on and arriving by climbing.

## What it is

After a decided floor, the result screen's "next floor" opens the tower instead of
posting the next request. The tower draws one row per floor in the order the
floors are fought — the fighter that floor is climbed against, and the player on
the one the run moved to, beside them — and its fight button is what asks for the
next floor, at the series length just fought. "Change mode" leaves, and the lobby
resumes the same floor.

## Why it waits for a tap

Auto-advancing when the animation ends was considered and rejected. It starts the
match underneath the one moment the ladder has to say something, and it makes the
transition's timing a property of the animation rather than of the player's
connection. One extra press puts the climb on a screen the player is looking at;
the alternative puts it over a result they are still reading.

## Why the movement is CSS

The markup is in match order and CSS lays it out bottom-up, so "up" is the floor's
number rather than a row index the renderer has to reason about in reverse. The hop
is the row height, and the client places the player on the final floor and lets the
keyframe carry them in — so there are no pixel offsets in `app.js` to disagree with
the layout when the tower gets taller or the rows get shorter. `prefers-reduced-motion`
drops the hop; the player is already on the right floor when it would have run.

## Why the finished run stands at the top

A cleared run's floor is reset to zero so the lobby does not offer a beaten ladder
as a run in progress. Reading that literally on the tower would end the run the
player just won by showing them back at its first floor, so the tower draws the top
and says the run is complete. The next order is still drawn by the request rather
than by the view: a redraw on the way in would draw an order that was never saved,
and a reload on the tower would then fight a different ladder from the one on
screen.

## Why the trailing idle frame is ignored there

The tower is reachable only from a decided match, so the server's `state idle`
teardown frame is already on its way when the player is standing on it. Every other
state routes that frame to the lobby; doing so here would walk a player off their
own ladder into the menu with the climb half played. The machine gives `ladder` no
`stateIdle` edge at all, and the handler ignores it beside the `result` guard.

## What it cost the server

Nothing. The tower draws the client's own stored order, and the fight it starts is
an ordinary `POST /cpu` — the same request the result screen's button used to make,
from a screen the player is looking at. No event, no field, no ladder state on the
wire; the client state machine gains one state and one event.

## Where the reasoning lives

[architecture](../../features/architecture.md#the-tower-is-the-runs-own-screen-not-a-decoration-on-the-result)
— why the climb waits for a tap, why the movement is CSS with no client-side
geometry, why a completed run stands at the top, and why the trailing idle frame
is expected here.

The wire-visible half is in
[protocol](../../features/protocol.md#client-state-machine), which mirrors the
client machine: `climb` from `result` to `ladder`, and `ladder` back out through
`matched`.

## Not in this build

- **The tower from the lobby.** It is a screen between floors, so a player can
  only see their ladder on the way to fighting one. Making it an entry of its own
  is a lobby change, not a tower one, and nothing about the tower depends on it.
- **Auto-advance.** Deliberate, above.
- **A defeated fighter falling.** A win and a loss both move the player; nothing
  on the losing floor changes state, so there is nothing to animate there.

## Depends on

[arcade-ladder](arcade-ladder.md) — the run, its floors and its progression are
that task's, and this one only draws them. The CPU series length came with it, so
the tower fights at the length just played for the same reason the result screen's
button did.