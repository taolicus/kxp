# The challenge link's Copy button gives no confirmation

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — `#btn-copy` selects the input and runs
`document.execCommand('copy')` (`app.js:1504-1510`) with no signal that
anything happened. The API is deprecated and can fail silently (permissions,
non-secure context); on failure the player is left with a selected field and
no clue whether the link is on the clipboard.

**Where it shows** — the queue view's challenge block, for the creator only
(`index.html:70-74`).

**Working hypothesis** — the button shipped with the challenge flow and the
feedback was deferred; the surrounding UI already has a pattern for transient
text (`#notice`, `setNotice`, `app.js:981`).

**Questions to resolve**

1. Confirmation on the button ("Copied!") vs a transient notice; duration and
   how it coexists with the share prompt.
2. `navigator.clipboard.writeText` with the current call as fallback — and
   what is shown when both fail (the field stays selected either way).
3. Is this worth doing given the flow already leaves the URL visible and
   selectable without the button?

**Proves the cause** — a decision on the confirmation pattern. The clipboard
call is not injectable in the client harness today, so a behaviour test needs
the call to be stubbable — worth stating in whatever task follows.

**Prospective fix (not scheduled)** — button-label flip on resolved promise,
`execCommand` kept as the fallback path.
