// Where the probes point.
//
// The production origin is deliberately NOT in this repository. It is the
// deployed address of a public, unauthenticated game server, and committing it
// turns every clone into a ready-made target list for scanners. There is a
// reason to require it out loud rather than default it quietly: a silent
// default is a probe that runs against whatever host it last saw, which reads
// as a pass when the real server is untested.
//
// Two ways to supply it, in precedence order:
//
//   1. the environment — best for a one-off:
//        BASE_URL=https://your-host npm run tall
//
//   2. tools/.base-url, which is gitignored — best for daily use, so the origin
//      is typed once instead of on every command:
//        echo 'https://your-host' > tools/.base-url
//
// It must be a full http(s) origin. Anything else is rejected here rather than
// producing confusing failures from every probe at once.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const LOCAL_FILE = resolve(here, '..', '.base-url');

const GUIDANCE = [
  'No origin for the probes to target.',
  '',
  'Set it once, outside the repo:',
  '',
  "  echo 'https://your-host' > tools/.base-url",
  '',
  'or per-command:',
  '',
  '  BASE_URL=https://your-host npm run tall',
  '',
  'tools/.base-url is gitignored, so the deployed address stays out of history.',
].join('\n');

// Reads the local override if present. Blank lines and `#` comments are skipped
// so the file can carry a note about which host it points at.
function readLocal() {
  if (!existsSync(LOCAL_FILE)) return '';
  try {
    return readFileSync(LOCAL_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .join('');
  } catch {
    return '';
  }
}

// A missing origin is a configuration mistake, not a test failure. It surfaces
// when the origin is first resolved, which a probe's script() does up front —
// before any request and before the script's own error handling exists — and
// the rejection of its top-level await arrives here as an uncaughtException.
// Marking the error lets it be reported as plain guidance instead of a stack
// trace through whatever module happened to trigger the resolution.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

process.on('uncaughtException', (err) => {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(3);
  }
  throw err;
});

export function resolveBase() {
  const raw = (process.env.BASE_URL || readLocal()).trim().replace(/\/+$/, '');
  if (!raw) throw new ConfigError(GUIDANCE);
  if (!/^https?:\/\//.test(raw)) {
    throw new ConfigError(`Origin must be a full http(s) origin, got: ${raw}\n\n${GUIDANCE}`);
  }
  return raw;
}
