(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KXP = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const aliases = { rock: '\u270a\uFE0F', paper: '\u270b\uFE0F', scissors: '\u270c\uFE0F' };

  // Plan the local PUN window for the client clock. elapsed is the time since
  // the server opened the window, measured in the server clock: the client
  // supplies skew = serverNow - clientNow (estimated from the `now` field in
  // the connected snapshot) so delivery lag is separated from phone/server
  // clock mismatch. remaining is the portion of the server's window that is
  // still open *for this client*. When the whole window has already elapsed
  // (lag exceeded windowMs) nothing is actionable locally: show no doomed PUN
  // and wait for the authoritative result. fallbackMs is used when the server
  // doesn't send a windowMs (reconnect snapshots).
  function shootWindow(clientNow, shootAt, windowMs, fallbackMs, skew) {
    const elapsed = shootAt ? clientNow + (skew || 0) - shootAt : 0;
    const total = windowMs || fallbackMs;
    const remaining = Math.max(0, total - elapsed);
    return { actionable: remaining > 0, remainingMs: remaining };
  }

  // The countdown beats, in the order they run, as the offset before the
  // announced PUN deadline at which each one begins. Mirrors countdownSlots in
  // round.go: READY at S-3s, KA at S-2s, CHI at S-1s, PUN at S. Keeping the
  // table here (rather than inline offsets) is what lets dueSlot and the timers
  // in app.js stay in step with the server's schedule.
  const COUNTDOWN_SLOTS = [['READY', 3000], ['KA', 2000], ['CHI', 1000]];

  // countdownSlot resolves which beat is showing at msUntilPun (the time left
  // before the announced deadline) and when the next one starts. It scans from
  // the last beat backwards for the first offset still ahead of us, which is
  // the beat that has begun but not yet ended. Before READY is due nothing is
  // showing, and at or past the deadline PUN itself is due, so no beat is
  // reported — that is what stops a late frame from flashing a beat with no
  // time behind it just before the window opens.
  // SLOT_CAP_MS bounds how long the countdown display will trust a single reading
  // of the clock. Without it, one bad reading parks the whole countdown on one
  // long timer and nothing repaints until that timer fires.
  const SLOT_CAP_MS = 1000;

  // countdownPainter returns a pure stepper for an on-screen countdown: call it
  // whenever the caller wants to re-check, and it says what is due and how long
  // until that could change. It re-derives from the clock on every call rather
  // than carrying a position forward, which is the whole point.
  //
  // It replaces a generator walked one beat per timer, and that version blanked
  // the entire countdown in two ways. Each delay was measured from the previous
  // step, so anything a runtime did to a timer accumulated down the chain; and the
  // chain was built once, from the first frame, so the later frames -- which all
  // carry the same shootAt -- could never correct it. A phone whose wall clock
  // stepped once between the snapshot and the round showed *no* countdown at all
  // despite three seconds remaining: the first reading scheduled a single long
  // timer and nothing repainted until it fired. Re-deriving bounds the cost of a
  // bad reading to one call, and because the stepper is idempotent the caller can
  // build a new one on every frame it receives without the restart being visible.
  //
  // `label` is non-null only when the due beat *changes*, so neither a redundant
  // check nor a fresh stepper repaints what is already on screen. `wait` is the
  // milliseconds until the next check: the time to the next beat, capped before
  // the first beat so a wrong clock is re-read rather than waited out, and zero
  // once PUN is due, which is the caller's cue to stop scheduling.
  //
  // skewFn rather than a skew value so a client that re-reads its skew mid-round
  // is not counting against the reading it started with.
  //
  // Pure by design: kxp.js never touches a timer or the DOM, so the caller owns
  // the scheduling and can be driven by an injected clock in tests. Keep it that
  // way -- a timer here would escape the vm the client tests run in.
  function countdownPainter(nowFn, shootAt, windowMs, skewFn) {
    let last = null;
    return function step() {
      const left = shootAt - (nowFn() + (skewFn ? skewFn() : 0));
      const slot = countdownSlot(left);
      let label = null;
      if (slot.label && slot.label !== last) {
        last = slot.label;
        label = slot.label;
      }
      const wait = slot.label ? slot.msUntilNext : Math.min(slot.msUntilNext, SLOT_CAP_MS);
      return { label, left, wait };
    };
  }

  function countdownSlot(msUntilPun) {
    if (msUntilPun <= 0) return { label: null, msUntilNext: 0 };
    for (let i = COUNTDOWN_SLOTS.length - 1; i >= 0; i--) {
      const [label, off] = COUNTDOWN_SLOTS[i];
      if (off >= msUntilPun) return { label, msUntilNext: msUntilPun - (off - 1000) };
    }
    return { label: null, msUntilNext: msUntilPun - COUNTDOWN_SLOTS[0][1] };
  }

  // planRound lays the announced round schedule onto the client clock. The
  // server pre-announces the PUN deadline (shootAt, epoch-ms) on the first
  // countdown frame, fixing each beat per COUNTDOWN_SLOTS and PUN at S. The
  // client shows PUN from the schedule even if the `shoot` frame stalls or
  // drops, so delivery can no longer cost the round. skew = serverNow -
  // clientNow, from the connected snapshot. Returns null without a plan
  // (pre-announce unseen). remainingMs is the portion of the window still open
  // measured from `now`. dueSlot/msUntilNextSlot say what is on screen right now
  // and when it changes, so the client paints the deadline rather than `n`.
  function planRound(now, shootAt, windowMs, skew) {
    if (!shootAt) return null;
    const total = windowMs || 2000;
    const msUntilPun = shootAt - (now + (skew || 0));
    const slot = countdownSlot(msUntilPun);
    return {
      msUntilReady: msUntilPun - 3000,
      msUntilKa: msUntilPun - 2000,
      msUntilChi: msUntilPun - 1000,
      msUntilPun,
      dueSlot: slot.label,
      msUntilNextSlot: slot.msUntilNext,
      actionable: msUntilPun + total > 0,
      remainingMs: Math.max(0, total + msUntilPun),
    };
  }

  // applyResult folds a match outcome into local statistics without mutating
  // the input. win: wins + streak (+best). loss: the streak that just ended is
  // recorded as last before resetting; a 0-run loss doesn't clobber last.
  // draw/void: no change.
  function applyResult(stats, outcome) {
    const s = {
      wins: stats.wins,
      streak: stats.streak,
      best: stats.best,
      last: stats.last || 0,
    };
    if (outcome === 'win') {
      s.wins += 1;
      s.streak += 1;
      if (s.streak > s.best) s.best = s.streak;
    } else if (outcome === 'loss') {
      if (s.streak > 0) s.last = s.streak;
      s.streak = 0;
    }
    // void is a no-contest: like a draw, it does not change wins/streak/best/last.
    return s;
  }

  // resultLines renders the result timing panel as plain text lines so the
  // app only has to join them; all formatting decisions are pure.
  function resultLines(d) {
    const lines = [];
    if (d.you || d.opponent) {
      const oppAlias = d.opponent ? aliases[d.opponent] : '\u2014';
      const oppMs = d.opponentClientMs != null ? d.opponentClientMs : d.opponentTimingMs;
      if (d.yourNote === 'timeout') lines.push('Timed out \u2014 no pick.');
      else if (d.yourNote === 'early') lines.push(`Disqualified \u2014 ${-d.youTimingMs}ms early.`);
      else if (d.yourNote === 'late') lines.push('Too late \u2014 the pick window had closed.');
      else {
        const youAlias = d.you ? aliases[d.you] : '\u2014';
        const youMs = d.youClientMs != null ? d.youClientMs : d.youTimingMs;
        lines.push(`You: ${youAlias}${youMs != null ? ` (${youMs}ms)` : ''}`);
      }
      lines.push(`Them: ${oppAlias}${oppMs != null ? ` (${oppMs}ms)` : ''}`);
    }
    return lines;
  }

  function rejectLabel(error) {
    return error === 'too early' ? 'TOO EARLY!'
      : error === 'too late' ? 'TOO LATE!'
      : error === 'move already submitted' ? 'ALREADY PICKED'
      : 'NOT ACCEPTED';
  }

  // beaconGate is the throttle for the client-side error beacon. Beacons are
  // fire-and-forget diagnostics, so they must never turn into a feedback loop:
  // a wedged SSE stream can fire onerror on every reconnect attempt, and each
  // would otherwise mint a /report request. Rules:
  //   - first beacon always passes;
  //   - one beacon per 5000ms regardless of kind;
  //   - an identical (kind, state) is only re-sent after 60s — the symptom
  //     either cleared or is repeating persistently, and a single sample is
  //     enough to capture it.
  // last is { ms, key } from the previous accepted beacon, or null.
  function beaconGate(kind, state, last, now) {
    const key = `${kind}|${state}`;
    if (!last) return { pass: true, key };
    if (now - last.ms < 5000) return { pass: false, key };
    if (key === last.key && now - last.ms < 60000) return { pass: false, key };
    return { pass: true, key };
  }

  // whenLabel is the "when" a match-history row shows: how long ago, in the
  // units a reader of a match list thinks in, and the date once days-ago stops
  // being useful. `now` is the caller's own reading of the clock, so nothing
  // here reads one -- the record it formats is display-only, and a clock this
  // file did not own would be one more to disagree with.
  function whenLabel(ts, now) {
    if (!Number.isFinite(ts)) return '';
    const ago = now - ts;
    if (ago < 60000) return 'just now';
    if (ago < 3600000) return `${Math.floor(ago / 60000)}m ago`;
    if (ago < 86400000) return `${Math.floor(ago / 3600000)}h ago`;
    return new Date(ts).toISOString().slice(0, 10);
  }

  return { aliases, shootWindow, planRound, countdownSlot, countdownPainter, applyResult, resultLines, rejectLabel, beaconGate, whenLabel };
}));