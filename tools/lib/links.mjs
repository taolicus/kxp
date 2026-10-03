// Internal documentation links: does every one of them still point somewhere?
//
// Every gate in this repo checks the thing it was written for. gofmt checks
// formatting, go test checks behaviour, the probes check the deployed server.
// Nothing checked the documentation's own link graph, which is why a renamed file
// could leave twenty files pointing at nothing and the tree still read as green.
// That is the same failure this repo has already been bitten by four times in
// prose: stale copies are invisible until someone follows one.
//
// The expensive mistake was not the absence of the check — it was keeping the
// check as an inline script. It lived in a shell heredoc, so it was rewritten by
// hand every time, tested never, and lost the moment the session compacted. The
// subtle parts (GitHub's heading slugs, anchors that need de-duplication) were
// re-derived each time and got slightly differently wrong each time. This file
// is the version that can be pinned, so the tricky branches are pinned.
//
// Scope is deliberately narrow: internal links and the anchors they name. It does
// not judge whether a sentence is true, whether a link points somewhere sensible
// rather than merely somewhere existing, or whether a document says the same
// thing twice. Those need a reader. What it can do without one is prove a path
// and a fragment still resolve, which is the failure that is mechanical, silent
// and invisible in review.

// Blank out fenced code blocks, preserving line numbering.
//
// Line-preserving is the whole point. Deleting the block instead would shift every
// line after it, and a finding reported at the wrong line number is a finding
// nobody follows. Replacing with empty lines costs memory and buys exact locations,
// which is the correct trade for a linter.
//
// This matters more than it looks: headings inside fences would otherwise register
// as real anchors, so a link to "#### 4. verify (below)" in a shell block would
// resolve and prove nothing.
export function stripFences(text) {
  const lines = text.split('\n');
  const out = new Array(lines.length);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence === null && m) {
      fence = m[1][0].repeat(3);
      out[i] = '';
      continue;
    }
    if (fence !== null) {
      out[i] = '';
      if (m && m[1][0].repeat(3) === fence) fence = null;
      continue;
    }
    out[i] = lines[i];
  }
  return out.join('\n');
}

// GitHub's heading slug: lowercase, drop punctuation except word characters
// (including _), hyphens and spaces, then spaces to hyphens.
//
// The punctuation rule is the part worth stating, because a plausible-looking
// approximation is wrong in a way that only shows up on headings nobody wrote
// yet. Underscores survive; "&" and "." and "**" do not; the spaces around a
// dropped character do not collapse, so "Character roster & portraits" is
// character-roster--portraits with two hyphens.
export function slugBase(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');
}

// Every anchor a document defines, de-duplicated the way GitHub numbers them.
//
// The numbering is load-bearing and not optional. A document with two headings
// that slug identically produces the second as "-1", so an implementation that
// just collects slugs into a set accepts a link to the first and would keep
// accepting it after the first is renamed — silently pointing at the wrong
// section. Returns a Set so callers only need membership.
export function anchors(text) {
  const found = new Map();
  const out = new Set();
  const re = /^(#{1,6})\s+(.*?)\s*$/gm;
  let m;
  while ((m = re.exec(stripFences(text))) !== null) {
    // A closed ATX heading ("## Foo ##") ends in hashes that are not part of
    // the text. They are punctuation, so slugBase drops them anyway; stripping
    // first keeps a heading of only hashes from becoming an empty slug.
    const base = slugBase(m[2].replace(/\s+#+$/, ''));
    if (!base) continue;
    const seen = found.get(base) ?? 0;
    found.set(base, seen + 1);
    out.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return out;
}

// Internal link targets in a document, with the line each one is on.
//
// Skips external schemes, which cannot be checked without a network and would
// turn a local gate into a flaky one. Catches inline links and images, since a
// missing image is the same bug as a missing link.
export function extractLinks(text) {
  const lines = stripFences(text).split('\n');
  const out = [];
  const re = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      out.push({ target, line: i + 1 });
    }
  }
  return out;
}

// Split a target into the path it names and the anchor it wants.
//
// A fragment-only target is the same file, which is why `path` comes back empty
// rather than null: the caller has to resolve it against the containing file, and
// getting that wrong makes "#verify" in every document resolve against the repo
// root.
export function splitTarget(target) {
  const hash = target.indexOf('#');
  if (hash === -1) return { path: target, anchor: '' };
  return { path: target.slice(0, hash), anchor: target.slice(hash + 1) };
}