# Production probe suite

Small, independent scripts that test the deployed server over the internet.
No browser, no local boot — just Node and the production origin.

## Why these exist

The server does not need a browser to be tested: everything it exposes is
`POST` endpoints plus one `GET /events` SSE stream ([docs/features/protocol.md](../docs/features/protocol.md)),
and Node's streaming `fetch` drives that directly.

The split is clear:

- **This suite** proves the *server* works from a phone: the full match loop
  over a real network, the timing of the 2s PUN window, and what happens when
  the link drops mid-round.
- **`npm run unit` / `npm run go`** cover the client state machine and the
  server internals offline, with no network at all.
- **Rendering, CSS and in-browser console errors** have no automated coverage
  here; see the host limits in [AGENTS.md](../AGENTS.md) for what is unverified.

## Proving you tested what you think you tested

This suite talks to a **deployed** origin, so it can only report on whatever
binary is currently answering. `t1` therefore checks that `/health`'s
`build.sha` matches `git rev-parse HEAD` in this checkout, and fails with a fix
hint if it does not — including when the field is missing entirely, which is
what a binary predating the check looks like.

Nothing is required to make this work: Go stamps the commit into any binary built
inside a git work tree, so `go build -o kxp .` is enough. A build from outside a
work tree has no such metadata and will report `sha: "unknown"`; label it
deliberately with:

```sh
go build -ldflags "-X main.buildSHA=$(git rev-parse HEAD)" -o kxp .
```

`build.modified` is reported separately from `sha`, so a binary built from a
dirty tree is caught even when the commit matches.

## Commands

| command | what it does | real matches |
| --- | --- | --- |
| `npm run t1` | link characterization: latency, drops, cold start; **asserts production serves the local HEAD** | no |
| `npm run t2` | `GET /health`, `/characters`, `/metrics` shapes | no |
| `npm run t3` | every roster fighter through `POST /character` | no |
| `npm run t4` | SSE frames, id handshake, clock skew | no |
| `npm run t5` | one CPU match end to end, with timing | 1 |
| `npm run t6` | drop the stream mid-match, reconnect, recover | 2 |
| `npm run t7` | every documented rejection code | 1 |
| `npm run t8` | PvP between two clients, plus the abandoned handshake | 2 |
| `npm run tall` | all of the above, one summary | 6 |
| `npm run tall -- t5 t6` | only the named ones | 3 |
| `QUICK=1 npm run tall` | skip everything that creates a match | 0 |

## Setting the origin

The suite needs the deployed origin and ships **no default** — it is the address
of a public, unauthenticated server, and committing it would hand every clone a
ready-made target list.

Set it once, outside the repo:

```
echo 'https://your-host' > tools/.base-url     # gitignored
```

or per-command:

```
BASE_URL=https://your-host npm run tall
```

`tools/.base-url` is consulted only when `BASE_URL` is unset, so the env var
still works as the quick override. It must be a full `http(s)` origin; anything
else is rejected up front rather than failing eight probes separately.

## Reading the verdict

Three outcomes, and the difference matters:

- **PASS** — the server behaved.
- **FAIL** — the server misbehaved. Go read that script's output.
- **INCONCLUSIVE** — *not* a server verdict, and the reason is named:
  - *(link dropped)* — the transport failed.
  - *(rate limited)* — this suite out-ran its own rate-limit budget.
  - *(ready gate expired — ack slower than the link allowed)* — the server
    waited its 8s for a `/ready` ack that the link was too slow to deliver, then
    did the designed thing and requeued the client. Re-run when the signal is
    better; `tall` calls these out separately, because a round really was lost.

That separation is the whole design. On a moving train most failures are the
network, and a suite that cannot tell the difference trains you to ignore it.
`WITHHELD` is a FAIL and means specifically that a frame went missing on a
stream that was healthy and fully acknowledged — a contract break. A missing
frame that follows some other failed check is reported as that failure instead,
so a lost round is not also filed as a protocol bug. `tall` exits `1` on a real
failure and `2` when something was inconclusive.

## Running order that makes sense

`npm run t1` first, always. It measures the path, so every later number can be
read against it — a match that takes 5s on a good link and 30s in a tunnel is
not a regression, and t1 is what proves that.

## Things the suite deliberately does not assert

- **`too late`.** The 2s window closes and the round resolves immediately
  after, so hitting that boundary from a bad link is luck. Reported, never
  asserted.
- **409 `move already submitted`.** It is a non-blocking send on a buffered
  channel (server.go:861-866), so it only fires while an earlier move is still
  unconsumed. Against a CPU the round resolves first, so t7 fires both
  submissions concurrently (a real double-tap) and accepts either the 409 or a
  clean `no active match`. It is a PvP-shaped code.

## PvP

`t8` self-pairs: two live streams queue, the server pairs them FIFO, and the
result frames are used to *prove* the pairing (`A.opponentCharacter` must equal
`B.youCharacter`) before any cross-side assertion is made. If a stranger was
queued and took a slot, the invariant checks still run and the win/loss
cross-check is skipped rather than reported as a failure against someone else's
match — the reasoning in gameplay.spec.js:23-31.

`scissors` beats `paper`. The suite keeps `BEATS` (what beats x) and `WINS`
(what x beats) as separate maps in `t8-pvp.mjs` for exactly this reason:
conflating them made an early draft assert that scissors loses to paper and
"discover" a scoring bug in `game.go` that does not exist.

### Known intermittent: stale `state` after a re-pair

`t8` scenario B abandons a PvP handshake and watches the survivor. Sometimes the
survivor is told about the new match *before* it is handed the old match's
teardown:

```
[matched@+7787ms, state@+7787ms]     ← the bad order
[state@+7787ms, matched@+7787ms]     ← the normal order
```

Both frames are emitted in the same millisecond, so the order depends on how
`m.finish()` (server.go:637-642) and the re-pairing in `m.requeue`
(server.go:595-607) interleave. `finishMatch` sends `state` to every side of the
old match unconditionally, without checking that the client has since been
re-paired. A browser reads that trailing `state` as a `stateIdle` edge out of
`matched` and drops to the lobby while the server still holds it in a live
match. It self-heals on the next handshake timeout, so it is cosmetic rather
than a wedge — but it is a real frame-ordering inconsistency.

Seen roughly 1 run in 7, so `t8` reports the order with timestamps and only
fails when the bad order actually occurs. Do not treat a single pass as proof it
is gone.

## Findings this suite has produced

Tracked in the docs rather than here, so they live with the rest of the plan:

- **Stale `state` teardown after a handshake re-pair** — landed in Phase 1.
  `docs/tasks/closed/stale-teardown-guard.md`, with the reasoning in
  `docs/decisions/stale-teardown-guard.md`. `t8` scenario B surfaced it.
- **Zero drop grace** — `docs/issues/drop-loss.md`. `t6` measured it: a 120ms gap
  loses the round, recovery is clean.
- **Clock skew ~4.8s** on the dev device, against a 2s PUN window. Not a defect
  — the client corrects for it — but it means the skew correction is
  load-bearing. `t4` reports the current value.

## Notes for the harness

`lib/harness.mjs` is shared. Two things in it are load-bearing and easy to
break:

- **`sse.mark()` before the action that provokes frames.** `wait()` defaults to
  a cursor of "now", which silently hides any frame that lands between the
  action and the call. On a fast link that is exactly where `matched` lands,
  because `POST /cpu` starts a match instantly, and the failure looks like a
  frame the server never sent.
- **Nothing in the SSE read loop may throw.** An exception there tears the
  stream down, the server reaps the abandoned connection
  (`sseWriteDeadline`, server.go:43), and every later `POST` then reports
  `not connected` — a harness bug wearing a server bug's clothes. This happened
  while writing the suite; frame parsing and waiter resolution are both
  defensive for that reason.

Bounds live in `BOUNDS` in `lib/harness.mjs` and are sized for a bad link, not
a datacenter. The server's own timing is matched+1s+1s+2s and the client arms a
6s stall watchdog, so anything under ~10s of slack is not a real bound.
