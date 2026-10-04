// Drives the real web/app.js readiness gate -- what has to be true before the
// server will start a round.
//
// The gate used to post /ready straight from the matched handler, which proved
// only that bytes had reached the browser. On a phone that is a much weaker claim
// than it looks: an app in the background acks exactly as reliably as one being
// watched, and the round then fires at somebody who never saw it coming. That is
// the same experience as a late first countdown frame -- a round arriving without
// warning -- from an unrelated cause, which is why it survived: from the lobby the
// two are indistinguishable.
//
// So the ack waits for a presented frame instead. requestAnimationFrame does not
// run in a backgrounded tab, which makes the gate self-suppressing: no frame, no
// ack, and the server's existing 8s timeout cancels the match. No new UI is
// involved, and the countdown tests already cover what happens once shootAt is
// known -- nothing else here can see whether the client ever asked to start.

const test = require('node:test');
const assert = require('node:assert');

const { loadApp, BGS } = require('./appHarness.cjs');
const SM = require('./machine.js');

// matched boots the client, connects, has the server say a match was found, and
// settles the announced background. It deliberately does NOT present a frame,
// because that is the interesting state: matched, screen up, nothing acknowledged
// yet.
//
// `settle` is what makes the background a precondition rather than an
// assumption. Pass false to hold the ack at the image load instead, which is the
// state the sequencing test needs.
async function matched(opts = {}) {
  const app = loadApp({ next: SM.next });
  await app.boot();
  app.fire('connected', { id: 'test-client', now: 1700000000000, online: 0 });
  app.fire('matched', Object.assign({ opponentName: 'Opponent' }, opts));
  if (opts.settle !== false) {
    app.loadImages();
    await app.settle();
  }
  return app;
}

const readies = (app) => app.posted().filter((p) => p === '/ready').length;

test('getting matched acknowledges nothing on its own', () => {
  // The regression this file exists for. Before it, matched() posted /ready
  // immediately, so an ack cost the player nothing and therefore proved nothing.
  // The count must still say what happened -- there is no prompt to duplicate now.
  const p = matched();
  return p.then((app) => {
    assert.equal(readies(app), 0, 'no ack without a presented frame');
    assert.equal(app.count(), 'MATCH FOUND');
  });
});

test('a presented frame acknowledges readiness', async () => {
  const app = await matched();
  app.frame();
  assert.equal(readies(app), 1, 'painting the round is the proof the server wants');
});

test('a hidden document does not acknowledge even when a frame arrives', async () => {
  // The case the whole change exists for. Some environments can deliver a frame
  // while the page is hidden, so the visibility check is a second gate rather than
  // a belt-and-braces afterthought -- without it a backgrounded app would ack
  // anyway and the round would fire at nobody, which is the original bug back.
  const app = await matched();
  app.visibility('hidden');
  app.frame();
  assert.equal(readies(app), 0, 'hidden means no ack');
});

test('nothing is acked while the app is backgrounded', async () => {
  // The realistic shape of it: a backgrounded tab is simply never handed a frame,
  // so the ack simply never happens and the server times out the handshake.
  const app = await matched();
  assert.equal(app.pendingFrames(), 1, 'a frame is owed');
  assert.equal(readies(app), 0, 'and nothing has been sent');
});

test('the ack is not repeated every frame', async () => {
  // The re-post loop is a 2s interval for a flaky link, not a per-frame send. If
  // it re-armed on rAF this would post once per frame, which is a request storm on
  // a slow device -- exactly the situation the gate exists to survive.
  const app = await matched();
  app.frame();
  app.frame();
  app.frame();
  assert.equal(readies(app), 1, 'still one ack');
});

test('a frame presented after the match ended acknowledges nothing', async () => {
  // The handshake timing out between matched and the first frame. Acking then
  // would be a request for a match that no longer exists.
  const app = await matched();
  app.fire('countdown', { n: 'READY', shootAt: 1700000003000, windowMs: 2000 });
  app.frame();
  assert.equal(readies(app), 0, 'no late ack once the countdown has begun');
});
// --- the announced stage, and what gates the ack on it ------------------------

test('the announced background is the stage that gets applied', async () => {
  // The server picks, per match, so both players see the same arena. A client
  // that applied its own random choice here would be right half the time, which
  // is the failure mode that hides: no error, just two players in two places.
  for (const bg of BGS) {
    const app = await matched({ background: bg });
    assert.equal(app.bgName(), bg, `announced ${bg} should be applied`);
  }
});

test('an unrecognised background name falls back to a known stage', async () => {
  // Roster drift is the real hazard: a name the server sends that this client has
  // no asset for would 404, and the game screen would come up unpainted. The Go
  // suite pins the two rosters against each other; this pins what happens if they
  // ever diverge anyway.
  const app = await matched({ background: 'volcano' });
  assert.ok(BGS.includes(app.bgName()), `got ${app.bgName()}, wanted a known stage`);
  assert.notEqual(app.bgName(), 'volcano', 'the unknown name was not trusted');
});

test('a match with no announced background still gets a stage', async () => {
  // The additive case: a new client against a server predating the field.
  const app = await matched();
  assert.ok(BGS.includes(app.bgName()), `got ${app.bgName()}, wanted a known stage`);
});

test('the ack waits for the announced background to load', async () => {
  // The sequencing the previous version got wrong. rAF fires on the next paint of
  // whatever is on screen, so arming the ack before the background resolved meant
  // the countdown could begin while the client was still showing the queue view --
  // the client acknowledged a match screen it had not yet drawn.
  const app = await matched({ background: 'tomb', settle: false });
  app.frame();
  await app.settle();
  assert.equal(readies(app), 0, 'no ack while the background is still downloading');
  assert.equal(app.pendingFrames(), 0, 'not even a frame is armed yet');

  app.loadImages();
  await app.settle();
  assert.equal(app.bgName(), 'tomb', 'stage applied once it loads');
  assert.equal(app.pendingFrames(), 1, 'the frame is armed only now');

  app.frame();
  assert.equal(readies(app), 1, 'and the ack follows the paint');
});

test('a background that fails to load still acknowledges', async () => {
  // A 404 on the stage must not hang the handshake. The server's 8s timeout would
  // cancel the match, so a broken asset would cost the player the round rather
  // than costing them a background. Measured: the ack still goes out.
  const app = await matched({ background: 'tomb', settle: false });
  app.loadImages(true);
  await app.settle();
  app.frame();
  assert.equal(readies(app), 1, 'a failed asset defers nothing');
});
