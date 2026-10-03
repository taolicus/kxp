#!/usr/bin/env node
// Check that every internal documentation link still resolves, and that every
// fragment it names is a heading that exists.
//
// The logic lives in lib/links.mjs so it can be unit-tested; this file is only
// the filesystem and the reporting. Run it with no arguments to check the whole
// tree, or pass paths to check a subset:
//
//   npm run links
//   npm run links -- docs/features/architecture.md AGENTS.md
//
// Exit status is 0 when everything resolves and 1 otherwise, so it drops into a
// hook or CI without needing the output read at all.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { anchors, extractLinks, splitTarget } from './lib/links.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git']);

function walk(target, out = []) {
  const st = statSync(target);
  if (st.isFile()) {
    if (target.endsWith('.md')) out.push(target);
    return out;
  }
  for (const name of readdirSync(target).sort()) {
    if (SKIP.has(name)) continue;
    walk(join(target, name), out);
  }
  return out;
}

// Anchors are read once per document and cached, because a document is commonly
// the target of several links and re-parsing it per link makes a whole-tree run
// quadratic for no benefit.
function anchorCache() {
  const cache = new Map();
  return (path) => {
    if (!cache.has(path)) {
      let set = new Set();
      try {
        set = anchors(readFileSync(path, 'utf8'));
      } catch {
        // Unreadable is reported as a missing file by the caller; do not cache a
        // guess, and do not throw out of a linter that should list every finding.
      }
      cache.set(path, set);
    }
    return cache.get(path);
  };
}

function main(argv) {
  const targets = argv.length ? argv : [repoRoot];
  const files = targets.flatMap((t) => walk(resolve(t)));
  const getAnchors = anchorCache();

  const findings = [];
  let links = 0;
  let anchorsChecked = 0;

  for (const file of files) {
    for (const { target, line } of extractLinks(readFileSync(file, 'utf8'))) {
      links++;
      const { path: rel, anchor } = splitTarget(target);
      // A fragment-only link names the document it is written in. Resolving it
      // against the repo root instead would make every same-file link fail.
      const dest = rel ? resolve(dirname(file), rel) : file;
      // Report paths relative to the repo root when the file is under it, and
      // absolute when it is not. A relative path that escapes the root with a
      // stack of ../ is technically correct and unreadable in practice, which is
      // the same as not reporting it.
      const shown = relative(repoRoot, file);
      const where = `${shown.startsWith('..') ? file : shown}:${line}`;

      if (!existsSync(dest)) {
        findings.push(`${where} -> ${target}  no such file`);
        continue;
      }
      if (anchor) {
        anchorsChecked++;
        if (!getAnchors(dest).has(anchor)) {
          findings.push(`${where} -> ${target}  no heading with that anchor`);
        }
      }
    }
  }

  for (const f of findings) console.log(f);

  const summary =
    `${files.length} documents, ${links} internal links` +
    (anchorsChecked ? `, ${anchorsChecked} fragments` : '') +
    `, ${findings.length} broken`;
  console.log(summary);
  process.exitCode = findings.length ? 1 : 0;
}

main(process.argv.slice(2));