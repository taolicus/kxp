(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StateMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = ['lobby', 'waiting', 'matched', 'countdown', 'shoot', 'locked', 'result'];

  const EVENTS = [
    'queue', 'cancel',
    'waiting', 'matched', 'countdown', 'shoot',
    'move', 'lock', 'reject',
    'result', 'opponentLeft',
    'stateIdle',
    'snapshot:idle', 'snapshot:waiting', 'snapshot:matched', 'snapshot:countdown', 'snapshot:shoot',
    'rematch:online', 'mode',
  ];

  const transitions = {
    lobby: { queue: 'waiting', waiting: 'waiting', matched: 'matched' },
    waiting: { cancel: 'lobby', matched: 'matched', waiting: 'waiting', stateIdle: 'lobby' },
    matched: { cancel: 'lobby', matched: 'matched', countdown: 'countdown', result: 'result', opponentLeft: 'result', stateIdle: 'lobby', waiting: 'waiting' },
    countdown: { countdown: 'countdown', matched: 'countdown', shoot: 'shoot', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    shoot: { move: 'locked', lock: 'locked', reject: 'locked', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    locked: { move: 'locked', reject: 'locked', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    // `countdown` is how a series re-enters a round: a non-final result is
    // followed by the next round's countdown frames. Without it the frame is
    // dropped, the round never starts, and the match hangs on a result screen --
    // so this edge is what makes "first to N" playable at all.
    result: { matched: 'matched', countdown: 'countdown', 'rematch:online': 'waiting', mode: 'lobby' },
  };

  STATES.forEach((s) => {
    transitions[s]['snapshot:idle'] = 'lobby';
    transitions[s]['snapshot:waiting'] = 'waiting';
    transitions[s]['snapshot:matched'] = 'matched';
    transitions[s]['snapshot:countdown'] = 'countdown';
    transitions[s]['snapshot:shoot'] = 'shoot';
  });

  function next(state, ev) {
    const row = transitions[state];
    if (!row) return null;
    return Object.prototype.hasOwnProperty.call(row, ev) ? row[ev] : null;
  }

  return { STATES, EVENTS, transitions, next };
}));