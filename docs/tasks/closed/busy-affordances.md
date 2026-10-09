# Busy affordances

Show a brief pending/disabled affordance on action buttons — Play Online, Instant
CPU, rematch, cancel, fighter select, move submit — while their request awaits the
SSE reply, so a long wait reads as "working" rather than silent.

A failsafe clears the affordance if the reply never comes. Also covers the
loading gap while "Waiting for result…".

**Decided and scheduled.**

## Landed

A button whose click awaits a server frame is marked `.pending` and disabled from
the click, and one failsafe re-arms it if the frame never lands. The mark is
cleared when a frame moves the screen on (any transition), when the request is
refused, or by the 8s failsafe. `armPending`/`clearPending` in `web/app.js` are
the whole mechanism; the spinner and lighter dim are a `button.pending` rule in
`web/style.css` reusing the existing `spin` keyframes.

The mechanism landed on the three buttons that genuinely await an SSE frame:
Play Online / Instant CPU (`#btn-start`), the CPU rematch (`#btn-again`), and the
tower's fight (`#ladder-fight`). The rest of the task's button list needs no
per-button affordance, and the loading gap is a different render:

- **cancel** changes the screen on the same click (`transition('cancel')`), so
  there is no window in which it is a dead button.
- **fighter select** posts `/character` fire-and-forget and redraws its selection
  immediately; nothing waits on a reply.
- **move submit** already has its affordance: the click transitions to `locked`,
  disables every move button and highlights the pick, which is what covers the
  moment before the result frame. What the task called the "Waiting for result…"
  gap is the copy in `enter.shoot`'s already-past-window branch, a different
  render that this slice deliberately leaves alone.

- **move submit** already has its affordance: the click transitions to `locked`,
  disables every move button and highlights the pick, which is what covers the
  moment before the result frame. What the task called the "Waiting for result…"
  gap is the copy in `enter.shoot`'s already-past-window branch, a different
  render that this slice deliberately leaves alone.

**Correction (same session).** The clear was first tied to `transition()`, so it
fired as soon as the `matched` frame was decided. But `showGame` defers the game
view behind the background decode, so the choose/tower screen stayed up for the
whole download with the button already re-armed — the player saw the spinner
vanish and the button go live before the match appeared. The clear now hangs off
`show()`, so it fires when the screen actually changes; the timing is pinned by
`web/app.pending.test.cjs`. The sentence above that says "when a frame moves the
screen on (any transition)" is the behaviour this correction replaces.

The behavioural tests were each checked to *fail* against the code before their
fix -- the failsafe and refusal tests against the pre-slice `web/app.js` (stashed
and rerun), the timing test against the commit that cleared at the transition --
so they cannot silently rot; the
two guards — a refusal re-arms, and an unmarked disabled button is left alone —
pass both ways by design. Verified on the phone: `npm run unit` 202/202 (four new
in `web/app.pending.test.cjs`), `npm run links` clean, and no Go file changed so
`go test ./...` was not run. The spinner itself has no automated coverage on
either host (no Chromium here), and the harness gained a `postStatus` option to
drive the refusal path.
