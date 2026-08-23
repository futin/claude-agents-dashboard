import assert from 'node:assert';

import { isTutorDeck, parseDeckMeta, extractTitle } from '../server/lib/guides.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
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

export function run(): number {
  console.log('\n=== guides.ts ===\n');
  let p = 0, f = 0;

  if (test('isTutorDeck: true for a real deck, false without the marker', () => {
    assert.strictEqual(isTutorDeck(DECK_FIXTURE), true);
    assert.strictEqual(isTutorDeck('<!DOCTYPE html><html></html>'), false);
  })) p++; else f++;

  if (test('isTutorDeck: false when the marker sits past the 1024-char window', () => {
    // The contract is "first 1024 chars" — put the marker at index 1024
    // exactly, one past the last byte `slice(0, 1024)` includes.
    const late = 'a'.repeat(1024) + '<!-- tutor-deck -->';
    assert.strictEqual(isTutorDeck(late), false);
  })) p++; else f++;

  if (test('parseDeckMeta: full stamp — title, generated, commit, sections all populated', () => {
    assert.deepStrictEqual(parseDeckMeta(DECK_FIXTURE), {
      title: 'The write paths',
      generated: '2026-08-20',
      commit: 'abc123def',
      sections: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }],
    });
  })) p++; else f++;

  if (test('parseDeckMeta: missing stamp leaves title alone, everything else null', () => {
    assert.deepStrictEqual(parseDeckMeta(DECK_NO_STAMP), {
      title: 'The write paths',
      generated: null,
      commit: null,
      sections: null,
    });
  })) p++; else f++;

  if (test('parseDeckMeta: malformed JSON in the stamp fails open the same way', () => {
    assert.deepStrictEqual(parseDeckMeta(DECK_BAD_JSON), {
      title: 'The write paths',
      generated: null,
      commit: null,
      sections: null,
    });
  })) p++; else f++;

  if (test('parseDeckMeta: drops a section missing title, keeps the valid one', () => {
    const result = parseDeckMeta(DECK_MALFORMED_SECTION);
    assert.deepStrictEqual(result.sections, [{ id: 's2', title: 'Two' }]);
  })) p++; else f++;

  if (test('extractTitle: plain title with no tutor suffix to strip', () => {
    assert.strictEqual(extractTitle('<title>Plain page</title>'), 'Plain page');
  })) p++; else f++;

  if (test('extractTitle: null when there is no <title> element', () => {
    assert.strictEqual(extractTitle('<html><body>no title here</body></html>'), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
