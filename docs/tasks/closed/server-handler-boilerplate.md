# De-duplicate the hub's handler boilerplate

`server.go`'s route handlers grew one at a time, and the same guarded preamble
is now copied across them. The copies are correct; the cost is that a change to
a shared rule (a new status, a different error body) has to be found in every
copy, and the seam-map split has more near-identical lines to move. This is a
mechanical extraction, not a behaviour change.

## The seams

Names are the contract; line numbers are as of the survey and will drift.

- **Not-connected guard** — eight copies of `c := h.client(id); if c == nil {
  handlerError(400, "not connected"); return }` (ready, move, queue, CPU,
  challenge, join, cancel, …). Extract
  `func (h *Hub) requireClient(w, id) *Client` that emits the error and returns
  nil, so each handler is `c := h.requireClient(w, req.ID); if c == nil { return }`.
- **Already-in-a-match guard** — four copies, all inside `h.mu`, each doing
  `if c.match != nil { h.mu.Unlock(); handlerError(409, "already in a match");
  return }`. Extract `rejectInMatchLocked(w, c) bool`.
- **Challenge drop** — three copies of "delete the pid's entry and its token
  map entry" (cancel, CPU, and a per-side variant in `finishMatch`). Extract
  `dropChallengeByPidLocked(pid)`; the token→creator loop in `finishMatch` is
  `dropChallengeByTokenLocked(tok)`.
- **Length normalize + validate + draw-end inference** — three copies
  (queue default `1`, CPU default `defaultSeriesTarget`, challenge default `1`)
  of validate-then-infer-`drawEnds`. Extract `normalizeTarget(t, def int,
  drawEnds *bool) (int, bool, string)`.
- **`{}` success body** — eight handlers write `w.Write([]byte("{}"))`, and only
  one sets `Content-Type: application/json` first (the rest are inconsistent).
  Extract `okJSON(w)` that sets the header and writes the body; the fix to the
  inconsistency is a side effect.
- **Gauges under lock** — `/health` and `/metrics` both take `h.mu`, read
  `len(h.clients)`/`len(h.queue)`, and unlock. Extract `gaugesLocked()`.
- **`c.match` under lock** — two sites take `h.mu`, read `m := c.match`, unlock,
  then `if m == nil { 400 "no active match" }`. Extract one accessor.

## Constraints

- **Pure extraction.** Same package, same behaviour, same status codes and
  bodies. No renames beyond the new helpers, no wire change.
- One helper per commit, each compiling and passing the full suite on its own.
- **Ordering note (not a dependency).** Doing this before
  [server-file-split](../open/server-file-split.md) means the split moves settled code,
  and the near-duplicate lines do not have to be moved twice. It also touches
  `finishMatch`'s challenge loops, which
  [match-termination-owner](../open/match-termination-owner.md) rewrites, so whichever of
  the two lands second does less. Neither *must* go first — the extractions are
  independent of both — so this carries no `depends-on`.
- The `-race` limit applies only if a lock discipline changes, which it should
  not: every extraction preserves the existing lock/unlock placement. If one
  cannot, say so in the commit and hand-check the ordering.

## Acceptance

`gofmt -l .` empty, `go vet ./...` clean, `go test ./...` green; a grep for each
duplicated snippet shows a single definition. The full suite is the real gate,
because the handlers' status codes and bodies are asserted in
`integration_test.go`.

## Landed

All seven seams extracted, one commit each, and each passed the full suite on
its own before the next opened: `requireClient`, `rejectInMatchLocked`,
`dropChallengeByPidLocked`/`dropChallengeByTokenLocked`, `normalizeTarget`,
`okJSON`, `gaugesLocked`, `activeMatch`. Every call site now names a single
definition — the acceptance's grep shows one definition per snippet, and the
eight `{}` writes and two gauge readings each route through one helper. Status
codes, bodies and the `unsupported roundsTarget` message are unchanged and
asserted by `integration_test.go`; `gofmt -l .` empty, `go vet ./...` clean,
and `go test ./...` green on each commit (197–207s per run on the phone).

No new test: this is pure extraction and the suite pins the handlers'
observable behaviour, which the four earlier commits re-verified as they went.
Lock placement was preserved in every helper that touches `h.mu` — each takes
or releases the same lock in the same window the inline code did — so no
`-race` claim is made; as ever, `-race` cannot run on this host and the laptop
is the place for a concurrency change. A stray self-invocation of `okJSON`
(seventh seam's `replaceAll`) stack-overflowed the suite and was caught by it
before any commit; the watch that caught it was the suite itself.
