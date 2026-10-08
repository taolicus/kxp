// Playwright config for the browser-level suite (`npm run e2e`).
//
// Like the probes, the suite drives the DEPLOYED server over the internet and
// never boots the app locally. Unlike the probes it needs a real browser, so it
// runs only on a host that can install Chromium — the MacBook Pro, not the
// phone (docs/development/environment.md).
//
// The origin comes from `tools/lib/base.mjs`, the one place that resolves it
// for every suite here: BASE_URL per command, else the gitignored
// tools/.base-url for daily use. A missing origin is a configuration mistake,
// so resolveBase() reports it as guidance at load rather than letting the run
// start against no target at all.
//
//   npm run e2e
//   BASE_URL=https://your-server.example npm run e2e
//
// One config, one command, one worker: each test makes a real match, so they
// run serially rather than competing for the server's queue.
import { resolveBase } from './tools/lib/base.mjs';

export default {
  testDir: './e2e',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: resolveBase(),
  },
};
