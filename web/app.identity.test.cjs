// Drives the real web/app.js identity plumbing under test.
//
// `id` is the SSE connection and is replaced whenever a newer stream connects;
// the pid is the server-issued player id that names the browser across reloads
// and tabs. It is an identity, not a credential. `go test` cannot run the client
// and the probes assert frames on the wire, so the persistence direction --
// storing the pid the server minted and presenting it on the next connect -- is
// only visible here, against the shared stubbed context.

const test = require('node:test');
const assert = require('node:assert');
const { runInContext } = require('node:vm');

const { loadApp } = require('./appHarness.cjs');

test('a stored player id is presented on the first connect', () => {
  const app = loadApp({ store: { 'kxp-pid': 'p-abc' } });
  runInContext('connect()', app.ctx);
  assert.match(app.sources[0].url, /[?&]pid=p-abc(?:&|$)/, 'the stored pid rides the connect URL');
});

test('a first-ever visit sends no player id', () => {
  const app = loadApp();
  runInContext('connect()', app.ctx);
  assert.ok(!/[?&]pid=/.test(app.sources[0].url), 'no pid is invented client-side');
});

test('the server-issued player id is persisted and carried into the reconnect', () => {
  const app = loadApp();
  runInContext('connect()', app.ctx);
  // The first snapshot mints both ids; the client stores the pid and reconnects
  // with its new connection id, which must carry the pid forward.
  app.fire('connected', { id: 'c1', pid: 'p-1', state: 'idle' });
  assert.equal(app.ctx.localStorage.getItem('kxp-pid'), 'p-1', 'the pid is persisted');
  assert.match(app.sources.at(-1).url, /[?&]pid=p-1(?:&|$)/, 'the reconnect presents the pid');
});
