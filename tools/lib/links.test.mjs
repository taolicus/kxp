// The link checker's only job is to notice that a path or a fragment stopped
// resolving, so a test that never fails on a broken document pins nothing. Each
// case below is a way the obvious implementation is wrong — the wrong slug on a
// heading nobody has written yet, an off-by-a-block line number, an anchor that
// resolves to the wrong duplicate heading. All of them pass silently.
//
// The slug tests use headings that do not appear in this repo on purpose. The
// documents here use clean lowercase-hyphen headings, so the interesting cases
// are unexercised by the corpus and would otherwise ship untested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripFences, slugBase, anchors, extractLinks, splitTarget } from './links.mjs';

test('stripFences blanks the block but keeps every line', () => {
  // Line preservation is what makes reported findings actionable. An
  // implementation that deletes the block instead reports every link after it at
  // the wrong line, and the report stops being usable.
  const src = ['before', '```sh', '[not a link](nope.md)', '# not a heading', '```', 'after [x](y.md)'].join('\n');
  const out = stripFences(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.equal(out.split('\n')[3], '');
  assert.equal(out.split('\n')[5], 'after [x](y.md)');
});

test('headings inside fences are not anchors', () => {
  // A shell block containing "# 1." must not make "# 1." a linkable section.
  const src = ['# Real', '```sh', '# comment', '```', '## Also real'].join('\n');
  assert.deepEqual([...anchors(src)].sort(), ['also-real', 'real']);
});

test('slugBase follows GitHub punctuation rules', () => {
  // Underscores survive. Everything else that is not a word character, a hyphen
  // or a space is dropped, and the spaces around a dropped character do not
  // collapse — that double hyphen is GitHub's actual behaviour.
  assert.equal(slugBase('h_mu and c_mu'), 'h_mu-and-c_mu');
  assert.equal(slugBase('Character roster & portraits'), 'character-roster--portraits');
  // The space before an existing hyphen merges with it: "test -race" is one
  // space and one literal hyphen, so two hyphens, not three.
  assert.equal(slugBase('`go test -race` refuses'), 'go-test--race-refuses');
  assert.equal(slugBase('**One home per work item.**'), 'one-home-per-work-item');
  assert.equal(slugBase('Why /health carries a build identity'), 'why-health-carries-a-build-identity');
});

test('closed ATX headings do not slug to their hashes', () => {
  // Asserted through anchors(), which is the real entry point: stripping the
  // closing sequence is anchors' job, not slugBase's, so slugBase("Closed ##")
  // is legitimately "closed-" and only the caller knows about closing hashes.
  assert.deepEqual([...anchors('## Closed ##\n\n## Closed\n\n## Real ##')].sort(), ['closed', 'closed-1', 'real']);
});

test('identical headings get numbered, so a rename cannot silently retarget a link', () => {
  // Without the numbering, a Set of slugs holds "notes" once and a link to the
  // second "# Notes" resolves to the first — and keeps resolving after the first
  // is renamed, now pointing somewhere the author did not choose.
  const set = anchors('# Notes\n\n# Notes\n\n# Notes\n');
  assert.deepEqual([...set].sort(), ['notes', 'notes-1', 'notes-2']);
});

test('extractLinks finds inline links and images, skips external schemes', () => {
  const line = '[a](x.md) ![i](img/y.png) [ext](https://e.com/z) [mail](mailto:a@b) [proto](//cdn/x)';
  assert.deepEqual(extractLinks(line), [
    { target: 'x.md', line: 1 },
    { target: 'img/y.png', line: 1 },
  ]);
});

test('extractLinks reports the line the link is really on', () => {
  // Reported against the unstripped document, because a finding at the wrong
  // line is one nobody follows.
  const src = ['# H', '', '```', '[fenced](no.md)', '```', '', '[real](yes.md)'].join('\n');
  assert.deepEqual(extractLinks(src), [{ target: 'yes.md', line: 7 }]);
});

test('extractLinks handles a fragment-only target and a title', () => {
  const out = extractLinks('[here](#verify) and [t](doc.md "A title")');
  assert.deepEqual(out, [
    { target: '#verify', line: 1 },
    { target: 'doc.md', line: 1 },
  ]);
});

test('splitTarget separates path from anchor, and says which is absent', () => {
  // Empty rather than null for a fragment-only target: the caller must resolve
  // "#x" against the containing file, and getting that wrong points every
  // same-file link at the repo root instead.
  assert.deepEqual(splitTarget('a/b.md#frag'), { path: 'a/b.md', anchor: 'frag' });
  assert.deepEqual(splitTarget('#frag'), { path: '', anchor: 'frag' });
  assert.deepEqual(splitTarget('a.md'), { path: 'a.md', anchor: '' });
});