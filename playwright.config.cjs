// Playwright config for the core-gameplay e2e suite.
//
// BASE_URL selects the target. Loaded from the environment so the same tests
// run anywhere a Chromium build exists:
//
//   BASE_URL=http://localhost:8080 npm run e2e:local   # local server (ops/CI host)
//   BASE_URL=https://example.com   npm run e2e:prod    # deployed server
//
// The suite is deliberately kept on one config; only BASE_URL differs. Tests
// create real matches by design (CPU and self-PvP), and self-PvP uses two
// isolated browser contexts that genuinely queue against a shared server.
//
// A base URL that points at localhost means "local": the config boots the Go
// server itself (webServer). Any other BASE_URL (deployed) assumes the server
// is already up behind that address and starts nothing.
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(baseURL);

module.exports = {
  testDir: './e2e',
  timeout: 90000,
  fullyParallel: false, // self-PvP + CPU each want a quiet server; run serially
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL,
  },
  // e2e:local boots the server; e2e:prod (non-local BASE_URL) targets the
  // deployed server, which the ops pipeline runs separately.
  webServer: isLocal
    ? {
        command: 'go run . -addr 127.0.0.1:8080',
        url: baseURL + '/health',
        reuseExistingServer: true, // the running binary / dev server counts
        timeout: 60000,
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
};