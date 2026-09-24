// Playwright config for the core-gameplay e2e suite.
//
// Production-only by scope: the suite tests the DEPLOYED server over the
// internet. It never boots the app locally, and the runner needs nothing but
// Node >= 20 and Playwright's Chromium.
//
//   BASE_URL=https://your-server.example npm run e2e
//
// BASE_URL is required — there is no local default — and must be the deployed
// server's origin (http(s)://). The suite fails fast at load if it's missing
// or malformed, rather than running against a wrong target.
//
// The suite is deliberately kept on one config and one command. Tests create
// real matches by design (CPU and PvP), and the PvP flow queues a first
// instance, waits a short bound for a real opponent, and only launches a
// second instance when none appears.
const baseURL = process.env.BASE_URL;
if (!baseURL) {
  throw new Error(
    'BASE_URL is required. Point it at the deployed (production) server, e.g.\n\n' +
      '  BASE_URL=https://your-server.example npm run e2e\n'
  );
}
if (!/^https?:\/\//.test(baseURL)) {
  throw new Error(`BASE_URL must be a full http(s) origin, got: ${baseURL}`);
}

module.exports = {
  testDir: './e2e',
  timeout: 90000,
  fullyParallel: false, // PvP + CPU each want a quiet server; run serially
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL,
  },
};