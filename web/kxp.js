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

  return { aliases, shootWindow, planRound, countdownSlot, applyResult, resultLines, rejectLabel, beaconGate };
}));