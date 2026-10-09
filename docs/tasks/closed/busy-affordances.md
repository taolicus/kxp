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

The two behavioural tests were checked to *fail* against the pre-change
`web/app.js` (stashed it and reran: both fail), so they cannot silently rot; the
two guards — a refusal re-arms, and an unmarked disabled button is left alone —
pass both ways by design. Verified on the phone: `npm run unit` 202/202 (four new
in `web/app.pending.test.cjs`), `npm run links` clean, and no Go file changed so
`go test ./...` was not run. The spinner itself has no automated coverage on
either host (no Chromium here), and the harness gained a `postStatus` option to
drive the refusal path.
