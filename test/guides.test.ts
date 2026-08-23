import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isTutorDeck, parseDeckMeta, extractTitle, scanGuides } from '../server/lib/guides.js';

function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

/** A tutor deck as the skill actually writes one — see docs/published-guides/tutor/*.html. */
const DECK_FIXTURE = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<head>
<title>The write paths — a tutor lesson</title>
<script type="application/json" id="provenance">
{"commit":"abc123def","generated":"2026-08-20","sources":["server/lib/pending.ts"],"sections":[{"id":"s1","title":"One","sources":["server/lib/pending.ts"]},{"id":"s2","title":"Two","sources":[]}]}
</script>
</head>
<body></body>
</html>`;

/** Same deck, minus the provenance script — decks written before the stamp existed. */
const DECK_NO_STAMP = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<head>
<title>The write paths — a tutor lesson</title>
</head>
<body></body>
</html>`;

/** Same deck; the stamp's body is not valid JSON. */
const DECK_BAD_JSON = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<head>
<title>The write paths — a tutor lesson</title>
<script type="application/json" id="provenance">
{not json
</script>
</head>
</html>`;

/** Stamp with one malformed section (missing title) and one valid one. */
const DECK_MALFORMED_SECTION = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<head>
<title>The write paths — a tutor lesson</title>
<script type="application/json" id="provenance">
{"commit":"abc123def","generated":"2026-08-20","sections":[{"id":"s1"},{"id":"s2","title":"Two"}]}
</script>
</head>
</html>`;

/* ---------------------------------------------------------- scanGuides fixtures */

/** Write a file under root, creating parent dirs. */
function put(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Marker'd deck with a full stamp: one section, a generated date. */
const DECK_A = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<head>
<title>Deck A</title>
<script type="application/json" id="provenance">
{"commit":"aaa111","generated":"2026-08-20","sections":[{"id":"s1","title":"One"}]}
</script>
</head>
<body></body>
</html>`;

/** Marker'd deck with no title and no stamp — proves the filename-fallback title and all-null metadata. */
const DECK_B = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<body></body>
</html>`;

/** Marker'd deck planted inside a guide dir, to prove non-descent (must never be listed). */
const DECK_BURIED = `<!DOCTYPE html>
<!-- tutor-deck -->
<html lang="en">
<head><title>Buried</title></head>
<body></body>
</html>`;

/**
 * Builds the fixture tree Task 2's brief specifies, under a fresh tmpdir, and
 * returns its path. Layout:
 *   index.html                        — root hub, no marker, must be skipped
 *   tutor/a-deck.html                 — marker + full stamp (dated)
 *   tutor/b-deck.html                 — marker, no stamp (undated)
 *   tutor/notes.md                    — non-html, ignored
 *   stray.html                        — html, no marker, ignored
 *   learning/dictation/index.html     — <title>Dictation</title>; makes this a GuideRef
 *   learning/dictation/guide/x.md     — inside the guide dir; must not surface
 *   learning/dictation/index2.html    — marker'd deck inside the guide dir; must NOT be listed
 *
 * Task 3 (resolveGuidePath / GUIDE_MIME) reuses this exact tree — extend it
 * in place rather than duplicating it.
 */
function makeGuidesFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
  put(root, 'index.html', '<title>Guides hub</title>');
  put(root, 'tutor/a-deck.html', DECK_A);
  put(root, 'tutor/b-deck.html', DECK_B);
  put(root, 'tutor/notes.md', '# notes\n');
  put(root, 'stray.html', '<title>Stray</title><p>no marker</p>');
  put(root, 'learning/dictation/index.html', '<title>Dictation</title>');
  put(root, 'learning/dictation/guide/x.md', '# source notes\n');
  put(root, 'learning/dictation/index2.html', DECK_BURIED);
  return root;
}

/** Minimal marker'd deck with an optional generated stamp, for ordering tests. */
function markerHtml(generated: string | null): string {
  const stamp = generated
    ? `<script type="application/json" id="provenance">{"generated":"${generated}"}</script>`
    : '';
  return `<!DOCTYPE html>\n<!-- tutor-deck -->\n<html><head>${stamp}</head><body></body></html>`;
}

export async function run(): Promise<number> {
  console.log('\n=== guides.ts ===\n');
  let p = 0, f = 0;

  if (await test('isTutorDeck: true for a real deck, false without the marker', () => {
    assert.strictEqual(isTutorDeck(DECK_FIXTURE), true);
    assert.strictEqual(isTutorDeck('<!DOCTYPE html><html></html>'), false);
  })) p++; else f++;

  if (await test('isTutorDeck: false when the marker sits past the 1024-char window', () => {
    // The contract is "first 1024 chars" — put the marker at index 1024
    // exactly, one past the last byte `slice(0, 1024)` includes.
    const late = 'a'.repeat(1024) + '<!-- tutor-deck -->';
    assert.strictEqual(isTutorDeck(late), false);
  })) p++; else f++;

  if (await test('parseDeckMeta: full stamp — title, generated, commit, sections all populated', () => {
    assert.deepStrictEqual(parseDeckMeta(DECK_FIXTURE), {
      title: 'The write paths',
      generated: '2026-08-20',
      commit: 'abc123def',
      sections: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }],
    });
  })) p++; else f++;

  if (await test('parseDeckMeta: missing stamp leaves title alone, everything else null', () => {
    assert.deepStrictEqual(parseDeckMeta(DECK_NO_STAMP), {
      title: 'The write paths',
      generated: null,
      commit: null,
      sections: null,
    });
  })) p++; else f++;

  if (await test('parseDeckMeta: malformed JSON in the stamp fails open the same way', () => {
    assert.deepStrictEqual(parseDeckMeta(DECK_BAD_JSON), {
      title: 'The write paths',
      generated: null,
      commit: null,
      sections: null,
    });
  })) p++; else f++;

  if (await test('parseDeckMeta: drops a section missing title, keeps the valid one', () => {
    const result = parseDeckMeta(DECK_MALFORMED_SECTION);
    assert.deepStrictEqual(result.sections, [{ id: 's2', title: 'Two' }]);
  })) p++; else f++;

  if (await test('extractTitle: plain title with no tutor suffix to strip', () => {
    assert.strictEqual(extractTitle('<title>Plain page</title>'), 'Plain page');
  })) p++; else f++;

  if (await test('extractTitle: null when there is no <title> element', () => {
    assert.strictEqual(extractTitle('<html><body>no title here</body></html>'), null);
  })) p++; else f++;

  if (await test('scanGuides: walks the fixture tree — decks dated-first, guide dir non-descent', async () => {
    const root = makeGuidesFixture();
    try {
      const result = await scanGuides(root);

      assert.strictEqual(result.decks.length, 2, 'expected exactly the two tutor/ decks');
      assert.strictEqual(result.decks[0].relPath, 'tutor/a-deck.html');
      assert.strictEqual(result.decks[0].title, 'Deck A');
      assert.strictEqual(result.decks[0].generated, '2026-08-20');
      assert.strictEqual(result.decks[0].commit, 'aaa111');
      assert.deepStrictEqual(result.decks[0].sections, [{ id: 's1', title: 'One' }]);

      assert.strictEqual(result.decks[1].relPath, 'tutor/b-deck.html');
      assert.strictEqual(result.decks[1].title, 'b-deck', 'no <title> should fall back to the filename stem');
      assert.strictEqual(result.decks[1].generated, null);
      assert.strictEqual(result.decks[1].commit, null);
      assert.strictEqual(result.decks[1].sections, null);

      assert.strictEqual(result.guides.length, 1, 'stray.html, notes.md, and the buried deck must not appear');
      assert.deepStrictEqual(result.guides[0], { relPath: 'learning/dictation', name: 'dictation', title: 'Dictation' });

      assert.strictEqual(typeof result.generatedAt, 'string');
      assert.ok(result.generatedAt.length > 0);
      assert.strictEqual('error' in result, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('scanGuides: missing guidesDir fails open — empty arrays, no throw, no error flag', async () => {
    const root = makeGuidesFixture();
    try {
      const result = await scanGuides(path.join(root, 'does-not-exist'));
      assert.deepStrictEqual(result.decks, []);
      assert.deepStrictEqual(result.guides, []);
      assert.strictEqual('error' in result, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('scanGuides: deck ordering ties (same date, and null-vs-null) break by relPath ascending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
    try {
      put(root, 'z-same.html', markerHtml('2026-08-20'));
      put(root, 'a-same.html', markerHtml('2026-08-20'));
      put(root, 'z-null.html', markerHtml(null));
      put(root, 'a-null.html', markerHtml(null));
      const result = await scanGuides(root);
      assert.deepStrictEqual(
        result.decks.map(d => d.relPath),
        ['a-same.html', 'z-same.html', 'a-null.html', 'z-null.html']
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('scanGuides: guide ordering is by name ascending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
    try {
      put(root, 'zeta/index.html', '<title>Zeta</title>');
      put(root, 'alpha/index.html', '<title>Alpha</title>');
      const result = await scanGuides(root);
      assert.deepStrictEqual(result.guides.map(g => g.name), ['alpha', 'zeta']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
