(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StateMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = ['lobby', 'waiting', 'matched', 'countdown', 'shoot', 'locked', 'result', 'ladder'];

  const EVENTS = [
    'queue', 'cancel',
    'waiting', 'matched', 'countdown', 'shoot',
    'move', 'lock', 'reject',
    'result', 'opponentLeft',
    'stateIdle',
    'snapshot:idle', 'snapshot:waiting', 'snapshot:matched', 'snapshot:countdown', 'snapshot:shoot',
    'rematch:online', 'mode',
    'climb',
  ];

  const transitions = {
    lobby: { queue: 'waiting', waiting: 'waiting', matched: 'matched', climb: 'ladder' },
    waiting: { cancel: 'lobby', matched: 'matched', waiting: 'waiting', stateIdle: 'lobby' },
    matched: { cancel: 'lobby', matched: 'matched', countdown: 'countdown', result: 'result', opponentLeft: 'result', stateIdle: 'lobby', waiting: 'waiting' },
    countdown: { countdown: 'countdown', matched: 'countdown', shoot: 'shoot', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    shoot: { move: 'locked', lock: 'locked', reject: 'locked', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    locked: { move: 'locked', reject: 'locked', result: 'result', opponentLeft: 'result', stateIdle: 'lobby' },
    // `countdown` is how a series re-enters a round: a non-final result is
    // followed by the next round's countdown frames. Without it the frame is
    // dropped, the round never starts, and the match hangs on a result screen --
    // so this edge is what makes "first to N" playable at all.
    result: { matched: 'matched', countdown: 'countdown', 'rematch:online': 'waiting', mode: 'lobby', climb: 'ladder' },
    // The tower between arcade floors. `climb` is how the run gets to it from both
    // directions: the result screen hands over after a floor, and the picker's
    // start button does from the lobby -- the picker is not a machine state, so
    // the machine is still in `lobby` there. The fight button on it posts the
    // request whose `matched` frame brings the client back, so that edge is not
    // optional: without it the match would start and the client would drop the
    // frame and sit on the tower. No `stateIdle`, for the reason `result` has
    // none -- after a floor the match is already decided, and before one it has
    // not started, so a teardown frame has nothing to reconcile from either way in,
    // and routing it to the lobby would walk the player off the tower.
    ladder: { matched: 'matched', mode: 'lobby' },
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