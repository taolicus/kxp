(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KXP = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const aliases = { rock: '\u270a\uFE0F', paper: '\u270b\uFE0F', scissors: '\u270c\uFE0F' };

  // Plan the local PUN window for the client clock. elapsed = delivery lag +
  // (clientClock - serverClock); remaining is the portion of the server's
  // window that is still open *for this client*. When the whole window has
  // already elapsed (lag/skew exceeded windowMs) nothing is actionable
  // locally: show no doomed PUN and wait for the authoritative result.
  // fallbackMs is used when the server doesn't send a windowMs (reconnect
  // snapshots).
  function shootWindow(now, shootAt, windowMs, fallbackMs) {
    const elapsed = shootAt ? now - shootAt : 0;
    const total = windowMs || fallbackMs;
    const remaining = Math.max(0, total - elapsed);
    return { actionable: remaining > 0, remainingMs: remaining };
  }

  // applyResult folds a match outcome into local statistics without mutating
  // the input. win: wins + streak (+best). loss: streak reset. draw: no change.
  function applyResult(stats, outcome) {
    const s = { wins: stats.wins, streak: stats.streak, best: stats.best };
    if (outcome === 'win') {
      s.wins += 1;
      s.streak += 1;
      if (s.streak > s.best) s.best = s.streak;
    } else if (outcome === 'loss') {
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
        lines.push(`You picked: ${youAlias}${youMs != null ? ` (${youMs}ms)` : ''}`);
      }
      lines.push(`Opponent picked: ${oppAlias}${oppMs != null ? ` (${oppMs}ms)` : ''}`);
    }
    return lines;
  }

  function rejectLabel(error) {
    return error === 'too early' ? 'TOO EARLY!'
      : error === 'too late' ? 'TOO LATE!'
      : error === 'move already submitted' ? 'ALREADY PICKED'
      : 'NOT ACCEPTED';
  }

  return { aliases, shootWindow, applyResult, resultLines, rejectLabel };
}));