// Playwright config for the browser-level suite (`npm run e2e`).
//
// Two modes, and the default is the self-contained one:
//
//   1. NO ORIGIN GIVEN — Playwright builds and boots the app itself through
//      `webServer` on 127.0.0.1:18080 and tears it down when the run ends.
//      Nothing outside this machine is touched, no match is created anywhere a
//      player can see, and the suite is reproducible on a hosted runner with no
//      secrets. This is what CI runs, and what `npm run e2e` does by default.
//
//        npm run e2e
//
//   2. ORIGIN GIVEN — the suite drives that origin instead and boots nothing.
//      This is the real-link run: a human pointing at the deployed server to
//      see how the same tabs behave over the internet.
//
//        BASE_URL=https://your-server.example npm run e2e
//
// The origin comes from `tools/lib/base.mjs` when one is supplied. A missing
// origin is no longer the configuration mistake it once was — it is the local
// mode selecting itself — so this config must not call resolveBase() blindly,
// which would exit 3 on the path that is now the common case.
//
// The locals are deliberately exempt from the probes' rule that a missing
// origin is a mistake: the probes MEASURE a link and are meaningless without
// one, while these specs produce a render and are better served by a server
// they control. Not booting production from a runner is the whole point — the
// specs queue, ack and play, so against a live origin every push would create
// real matches and the gate would flake whenever production was mid-deploy.
//
// One config, one command, one worker: each test makes a real match, so they
// run serially rather than competing for the queue they share.
import { defineConfig } from '@playwright/test';
import { LOCAL_FILE } from './tools/lib/base.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT || 18080;
const LOCAL_ORIGIN = `http://127.0.0.1:${PORT}`;
// Unique per port so two runs on different ports do not fight over one file.
const fixtureBin = join(tmpdir(), `kxp-e2e-${PORT}`);

// `BASE_URL` wins, then the gitignored tools/.base-url a developer set for
// daily use. Read here rather than through resolveBase() so that its absence is
// `undefined` (local mode) instead of the ConfigError guidance the probes want.
function configuredOrigin() {
  const env = (process.env.BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  if (!existsSync(LOCAL_FILE)) return undefined;
  try {
    const file = readFileSync(LOCAL_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .join('')
      .replace(/\/+$/, '');
    return file || undefined;
  } catch {
    return undefined;
  }
}

const origin = configuredOrigin();

export default {
  testDir: './e2e',
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin ?? LOCAL_ORIGIN,
  },
  // Omitted entirely in mode 2 so a real-link run never has a local binary
  // compete for the port or get silently used instead of the origin asked for.
  webServer: origin
    ? undefined
    : {
        // Built then run rather than `go run .`, so the readiness check below
        // times the server's start instead of the Go compiler's. The binary
        // goes to the system temp dir rather than the repo: it keeps the tree
        // clean, and it is the one path here that is guaranteed to be on a
        // filesystem that allows execution (the phone's FUSE storage does not —
        // the same limit that makes `deploy.sh` a `sh deploy.sh`).
        //
        // No port auto-pick is relied on: -addr pins 18080, and since main.go
        // only *logs* a taken port and then scans 8000–8999, the url probe
        // below — not the bind — is what proves the server answered.
        command: `go build -o "${fixtureBin}" . && "${fixtureBin}" -addr 127.0.0.1:${PORT}`,
        url: `${LOCAL_ORIGIN}/`,
        timeout: 180000,
        reuseExistingServer: !process.env.CI,
      },
};
