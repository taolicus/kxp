# Matchmaking should hand every player a code to share and a field to paste one

**Provenance** — a design proposal recorded at the owner's request, not an
observed symptom. The default model below is a decision taken while shaping it.

**The proposal** — hitting *Play Online* immediately yields a short code the
player shares through the browser's Share API, next to a field for pasting
someone else's code. Sharing a code and entering one are the two halves of the
same screen, presented together rather than as a mode selected before the wait.

**The decided shape — invite-first, reservation by default.** *Play Online*
opens one screen: your code, a paste field, and (if it is wanted at all) a
secondary "search for anyone" toggle. Holding a code **reserves** you: you are
not in the global FIFO scan, so the friend you shared with cannot lose you to a
stranger in the seconds before they paste. Claiming a code pairs you through the
same `makeMatch`/`startMatchLocked` path everything else uses, at the creator's
length. This is today's `POST /challenge` promoted to the default; the separate
"Create Challenge" mode disappears.

**Why invite-first, and why the empty-queue worry does not block it.** The
alternative was to keep the queue as the default and treat the code as a
shortcut into it, with the FIFO scan and code-claim racing for the same entry.
Rejected: the race is exactly the failure a code exists to remove, and it would
make the code a promise it cannot keep. The usual objection — "if everyone
reserves, nobody is in the random pool" — assumes the game will have a standing
pool of waiters at an arbitrary moment. It very likely will not; optimizing the
default around random availability is designing for a supply that will not be
there. Invite is the primary entry; random matching is the fallback, not the
mode.

**Gated on a persistent identity.** Most of the messy scoping — the code's
lifetime, tabs, cross-client consistency — is a symptom of reservations keyed to
the SSE connection. Today `removeClient` deletes a challenge on disconnect
(`server.go:516-522`) and a dead creator stream reads as gone
(`server.go:1347`), so a shared link dies whenever the creator backgrounds the
phone; each tab is a distinct `Client`, so a code minted in one tab stays live
while you join someone else in another, and the same-connection guard
(`server.go:1355`) does not stop a self-join from a second tab. Keying the
reservation to a persistent anonymous ID instead collapses all three into
server-enforced "one open code per identity", surviving drops and coordinating
tabs. That primitive is the model chosen in
[player-identity](player-identity.md) and built as
[identity-registry](../tasks/closed/identity-registry.md) and
[identity-owned-matchmaking](../tasks/closed/identity-owned-matchmaking.md), both
landed: the reservation is now keyed to the player, so those three symptoms are
resolved rather than argued around, and this issue waits on neither — what
remains is the invite-first UI on top of the re-key.

**Where it shows** — the lobby's mode control and the queue view
(`web/index.html`, `web/app.js`), the challenge endpoints
(`POST /challenge`, `POST /join`), the `challenge` field the `connected`
snapshot already carries, and the identity the connect path would gain.

**What exists today** — the two halves live in different flows. A challenge is a
separate mode ("Create Challenge", `app.js:1509`) that leaves the queue and
mints `/?challenge=TOKEN`; the link is shown in the queue view with a Copy
button (`app.js:1621`) and rehydrated from the snapshot on reconnect
(`app.js:1385`, `protocol.md` `connected`). There is no Share API use, no code
format, and no paste field — a claimant follows the URL and the client posts
`/join` once per page load behind a latch (`architecture.md#matchmaking`). Plain
*Play Online* still only joins the global FIFO queue (`POST /queue`).

**What merging changes in the existing mechanism**

- `/challenge` stops being a mode: the token hangs off the identity's wait, so
  the snapshot's `challenge` field becomes "the code for any wait" and the
  separate *Create Challenge* button goes.
- Today's `409 challenge already open` on `/queue` exists precisely to stop a
  shared link being paired away. Invite-first keeps that promise, so the
  endpoint mostly stays; what changes is that opening a code is now what *Play
  Online* does rather than a second choice.
- `m.requeue` today *is* the challenge closure returning false, so the survivor
  of an aborted handshake goes to the lobby rather than the global queue. With
  invite as the default, that stays correct for a code-paired match, and the
  match still has to record its provenance if the random toggle ever re-queues.
- The reservation, the snapshot, and `removeClient`'s teardown re-key from the
  connection to the identity — a change to the SSE lifecycle, not just a field.

**Scoping that identity does not settle**

1. Code or link, and what length it carries. Today a challenge is hardwired
   one-round, `drawEnds=true` (`server.go:1366-1367`); invite-first should pair
   at the creator's chosen length, so decide where length is picked and whether
   the code is a short lookup or the existing token.
2. What Share sends — the code as text, the URL, or both — and what is shown
   when `navigator.share` is absent or the share is dismissed (desktop,
   non-secure context, user cancel).
3. What the paste field accepts, and what it says when the code is unknown,
   spent (`404 challenge gone`), or already in play (`409 challenge in play`).
   Today those surface through the snapshot, not a form; an explicit paste needs
   confirm-vs-auto-join semantics, where the current flow auto-posts behind the
   page-load latch.
4. Does a short code change the abuse story on an unauthenticated server — a
   guessable reservation, versus today's token — or is it the same token with a
   friendlier face?
5. Does "search for anyone" ship now (reserving, then joining the FIFO), or does
   random matching stay the existing plain `/queue` behind its own control?
6. What a finished series leaves: a challenge survivor's `requeue` returns false
   (`server.go:1377`) and the token is spent at termination, so decide whether a
   rematch mints a new code or the winner lands back on a fresh invite screen.

**Decided scoping.** Four calls settle the questions above, all taken with the
owner:

1. **Opaque link, paste either form.** The code *is* today's server-issued token
   in a `/?challenge=TOKEN` URL — no short code, so the abuse story is unchanged.
   The paste field accepts a full pasted URL or a bare token and extracts the
   token from either.
2. **Search for anyone ships now**, as a secondary control on the invite screen:
   it leaves the reservation (the same intent as cancel) and joins the global
   FIFO queue at the lobby's chosen length.
3. **Claim is explicit.** A Confirm button beside the paste field posts `/join`
   and surfaces `404 challenge gone` / `409 challenge in play` inline; opening a
   `?challenge=` URL still auto-claims through the existing page-load latch, so a
   tapped link stays one tap.
4. **Play Again returns to the invite screen**, minting a fresh reservation —
   invite-first end to end, rather than re-queueing the FIFO.

The build is three slices: [invite-match-length](../tasks/closed/invite-match-length.md)
(server, landed), [invite-first-entry](../tasks/closed/invite-first-entry.md) (client +
markup, landed), and [invite-share](../tasks/closed/invite-share.md) (Share API,
landed).

**Proves the cause** — a recorded decision on the code format (question 1) and
on the identity primitive (player-identity). The paste UI and error states
follow, and only then does this graduate to a task.

**Prospective fix (not scheduled)** — reuse `makeMatch`/`startMatchLocked` and
the token lifecycle the challenge flow already pins, keyed to the identity rather
than the connection; make the invite screen the default path out of the lobby;
add the Share/paste UI; keep the wire change additive so a tab open across the
deploy still pairs.
