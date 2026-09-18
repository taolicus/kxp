(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StateMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = ['lobby', 'waiting', 'countdown', 'shoot', 'locked', 'result'];

  const EVENTS = [
    'queue', 'cancel',
    'waiting', 'matched', 'countdown', 'shoot',
    'move', 'lock', 'reject',
    'result', 'opponentLeft',
    'stateIdle',
    'snapshot:idle', 'snapshot:waiting', 'snapshot:countdown', 'snapshot:shoot',
    'again',
  ];

  const transitions = {
    lobby: { queue: 'waiting', waiting: 'waiting', matched: 'countdown' },
    waiting: { cancel: 'lobby', matched: 'countdown', waiting: 'waiting', stateIdle: 'lobby' },
    countdown: { countdown: 'countdown', shoot: 'shoot', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    shoot: { move: 'locked', lock: 'locked', reject: 'locked', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    locked: { move: 'locked', reject: 'locked', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    result: { again: 'lobby' },
  };

  STATES.forEach((s) => {
    transitions[s]['snapshot:idle'] = 'lobby';
    transitions[s]['snapshot:waiting'] = 'waiting';
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