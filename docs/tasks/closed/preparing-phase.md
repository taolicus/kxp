# A `preparing` phase between idle and countdown

Reading the CPU match lifecycle end to end showed a step that had no name. Steps
3–5 read as "client taps Fight, server does something, client is waiting", and
what the server was actually doing in that gap was unnamed — worse, it was named
`countdown`, so a phase called after something that had not started yet covered
the entire span before the first countdown frame.

`preparing` now covers exactly that span: the round's background is chosen,
`matched` has gone out, clients are loading assets for the match screen, and the
readiness gate is waiting on every human side. `countdown` begins when the gate
opens — every human's screen is up and has acked — and is the first phase in
which any countdown frame can exist.

Two things the split forced into the open, both worth having been forced:

- **`handleReady` had to widen.** It gated on `phaseCountdown`, which was the
  phase the gate was open in *by accident of naming*. Narrowing the naming to the
  real window meant the handler had to accept `preparing` explicitly, since acks
  are what close that phase — a handler still testing `phaseCountdown` alone
  answers 409 to every ack that matters and every match can then only end in a
  timeout. This was close to shipping as a total handshake outage.
- **The `pending` snapshot flag had to move.** It meant "mid-handshake, re-admit
  and re-ack" and was derived from `phase == "countdown" && !allHumanReady()`. It
  is now `phase == "preparing" && !allHumanReady()`, which is the honest
  condition; the deadline fields stay excluded from `preparing` because no
  deadline exists yet to leak.

The wire label changed with it: `phase` in the reconnect snapshot is now
`preparing`, where it was `countdown`. That breaks a tab open across a deploy,
because such a client tests `phase === "countdown" && pending` to rejoin a
handshake and would instead take a different transition without re-arming its ack.
Accepted deliberately — this project has no live users, so the stranded client
does not exist, and the alternative was keeping a name the server had stopped
believing. `app.js` accepts both spellings, so the only broken pairing is an old
client against a new server. Recorded in
[protocol.md](../../features/protocol.md#match-lifecycle).

Backgrounds were re-confirmed as staying client-side assets: the server sends the
*choice*, never the bytes, and picks one value for the whole match so both sides
see the same stage. That is a separate slice and is not started.

→ rationale: [protocol.md#match-lifecycle](../../features/protocol.md#match-lifecycle)