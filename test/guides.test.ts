import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { isTutorDeck, parseDeckMeta, extractTitle, scanGuides, resolveGuidePath, GUIDE_MIME } from '../server/lib/guides.js';
import { serveGuidesIndex, serveGuideFile } from '../server/api.js';
import { loadConfig, type Config } from '../server/lib/config.js';
import { decodePath } from '../server/index.js';

function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

/* ---------------------------------------------------------- Task 4: endpoint test helpers */

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/**
 * GET `urlPath` from a one-shot server running `handler`, and return the
 * reply. Same shape (and the same settle-exactly-once guard) as the `post`
 * helper in test/api-body.test.ts / test/spawn-endpoint.test.ts — a bare
 * `http.request` has no default `'error'` listener, and without one a late
 * socket error becomes an unhandled throw that kills the whole `pnpm test`
 * process instead of failing one case.
 */
function get(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  urlPath = '/'
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      srv.close();
      fn();
    };
    srv.on('error', e => settle(() => reject(e)));
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      const req = http.request({ port, method: 'GET', path: urlPath }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => settle(() => resolve({ status: res.statusCode || 0, headers: res.headers, body: raw })));
        res.on('error', e => settle(() => reject(e)));
      });
      req.on('error', e => settle(() => reject(e)));
      req.end();
    });
  });
}

/** A .env path guaranteed not to exist, so a developer's real .env can't leak into these configs. */
const NONEXISTENT_ENV = path.join(os.tmpdir(), 'guides-endpoint-nonexistent.env');

/**
 * A `Config` whose `guidesDir` is `dir`, built through the real
 * `GUIDES_DIR` env var → `loadConfig` path rather than a hand-built object,
 * so these tests also exercise the same wiring the loadConfig tests check in
 * isolation. `loadConfig` is synchronous, so the env var is set and restored
 * with no async window where a concurrent access could observe the override.
 */
function guidesConfig(dir: string): Config {
  const prev = process.env.GUIDES_DIR;
  process.env.GUIDES_DIR = dir;
  try {
    return loadConfig({ envPath: NONEXISTENT_ENV });
  } finally {
    if (prev === undefined) delete process.env.GUIDES_DIR; else process.env.GUIDES_DIR = prev;
  }
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

/**
 * Real files created outside any guides-fixture root, to be symlinked from
 * inside one (for traversal-escape tests). `makeGuidesFixture` only returns
 * `root`, and every existing call site cleans up just `root` in its own
 * `finally` — so these are tracked here and swept once at the very end of
 * `run()` instead of per-test.
 */
const outsideDirs: string[] = [];

/** A real file living outside any fixture root — a symlink escape target. */
function makeOutsideFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-outside-'));
  outsideDirs.push(dir);
  const file = path.join(dir, 'secret.html');
  fs.writeFileSync(file, '<title>secret</title>');
  return file;
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
 *   tutor/escape.html                 — SYMLINK to a real file outside the tmpdir entirely;
 *                                        for resolveGuidePath traversal tests. Harmless to
 *                                        scanGuides: fs.Dirent.isFile() is false for a
 *                                        symlink dirent (unfollowed), so scanDir's
 *                                        `!entry.isFile()` guard skips it before the
 *                                        `.html` check ever runs — decks.length stays 2.
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
  fs.symlinkSync(makeOutsideFile(), path.join(root, 'tutor', 'escape.html'));
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

  /* ---------------------------------------------------------- resolveGuidePath */

  if (await test('resolveGuidePath: a real deck resolves to its realpath\'d absolute path', () => {
    const root = makeGuidesFixture();
    try {
      const expected = fs.realpathSync(path.join(root, 'tutor', 'a-deck.html'));
      assert.strictEqual(resolveGuidePath(root, 'tutor/a-deck.html'), expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('resolveGuidePath: rejects traversal, absolute path, empty, a directory, a missing file, and the escape symlink', () => {
    const root = makeGuidesFixture();
    try {
      const cases = ['../x', 'a/../../x', '/etc/passwd', '', 'tutor', 'tutor/missing.html', 'tutor/escape.html'];
      for (const relPath of cases) {
        assert.strictEqual(resolveGuidePath(root, relPath), null, `expected null for ${JSON.stringify(relPath)}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('resolveGuidePath: extra edge cases — bare "..", ".", backslash, embedded NUL, missing guidesDir', () => {
    const root = makeGuidesFixture();
    try {
      assert.strictEqual(resolveGuidePath(root, '..'), null, 'bare ".." with no slash is still a ".." segment');
      assert.strictEqual(resolveGuidePath(root, '.'), null, 'resolves to guidesDir itself, which is not a file');
      assert.strictEqual(resolveGuidePath(root, 'tutor\\a-deck.html'), null, 'backslash');
      assert.strictEqual(resolveGuidePath(root, 'tutor/a-deck.html\0.png'), null, 'embedded NUL byte must not throw');
      assert.strictEqual(resolveGuidePath(path.join(root, 'does-not-exist'), 'tutor/a-deck.html'), null, 'guidesDir itself missing must not throw');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('resolveGuidePath: a filename merely containing ".." (not a full segment) is not rejected on that ground', () => {
    const root = makeGuidesFixture();
    try {
      put(root, 'tutor/a..b.html', '<title>dotted</title>');
      const expected = fs.realpathSync(path.join(root, 'tutor', 'a..b.html'));
      assert.strictEqual(resolveGuidePath(root, 'tutor/a..b.html'), expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('resolveGuidePath: symlink to a sibling dir sharing guidesDir as a raw string prefix is rejected (the separator check)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
    const sibling = root + '-secret'; // e.g. ".../guides-XXXX-secret" — starts with ".../guides-XXXX"
    fs.mkdirSync(sibling);
    try {
      fs.mkdirSync(path.join(root, 'tutor'), { recursive: true });
      fs.writeFileSync(path.join(sibling, 'leak.html'), '<title>leak</title>');
      fs.symlinkSync(path.join(sibling, 'leak.html'), path.join(root, 'tutor', 'sibling-escape.html'));
      assert.strictEqual(resolveGuidePath(root, 'tutor/sibling-escape.html'), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('resolveGuidePath: a symlinked directory that resolves outside guidesDir is rejected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'file.html'), '<title>outside file</title>');
      fs.mkdirSync(path.join(root, 'tutor'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'tutor', 'linked-dir'));
      assert.strictEqual(resolveGuidePath(root, 'tutor/linked-dir/file.html'), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  })) p++; else f++;

  /* ---------------------------------------------------------- GUIDE_MIME */

  if (await test('GUIDE_MIME: the two guide-specific entries have the exact documented values', () => {
    assert.strictEqual(GUIDE_MIME['.mjs'], 'text/javascript; charset=utf-8');
    assert.strictEqual(GUIDE_MIME['.md'], 'text/markdown; charset=utf-8');
  })) p++; else f++;

  if (await test('GUIDE_MIME: mirrors the eight server/index.ts entries verbatim, ten keys total, no case-folding', () => {
    // Checked before deepStrictEqual deliberately: @types/node types it as
    // `asserts actual is T`, so TS narrows GUIDE_MIME's static type to the
    // literal shape below afterward, and a `['.HTML']` lookup past that
    // point fails to typecheck (no such key on the narrowed type) even
    // though it is perfectly valid at runtime.
    assert.strictEqual(GUIDE_MIME['.HTML'], undefined, 'no case-folding, same as the map it mirrors');
    assert.deepStrictEqual(GUIDE_MIME, {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.mjs': 'text/javascript; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
    });
  })) p++; else f++;

  /* ---------------------------------------------------------- Task 4: loadConfig */

  if (await test('loadConfig: guidesDir defaults to <cwd>/docs/published-guides when GUIDES_DIR is unset', () => {
    const prev = process.env.GUIDES_DIR;
    delete process.env.GUIDES_DIR;
    try {
      const cfg = loadConfig({ envPath: NONEXISTENT_ENV });
      assert.ok(
        cfg.guidesDir.endsWith(path.join('docs', 'published-guides')),
        `expected guidesDir to end with docs/published-guides, got ${cfg.guidesDir}`
      );
    } finally {
      if (prev === undefined) delete process.env.GUIDES_DIR; else process.env.GUIDES_DIR = prev;
    }
  })) p++; else f++;

  if (await test('loadConfig: GUIDES_DIR is trimmed, same shape as claudeBin', () => {
    const prev = process.env.GUIDES_DIR;
    process.env.GUIDES_DIR = '/tmp/x ';
    try {
      const cfg = loadConfig({ envPath: NONEXISTENT_ENV });
      assert.strictEqual(cfg.guidesDir, '/tmp/x');
    } finally {
      if (prev === undefined) delete process.env.GUIDES_DIR; else process.env.GUIDES_DIR = prev;
    }
  })) p++; else f++;

  /* ---------------------------------------------------------- Task 4: serveGuidesIndex */

  if (await test('serveGuidesIndex: 200 with the fixture\'s GuidesIndex, Cache-Control: no-store', async () => {
    const root = makeGuidesFixture();
    try {
      const cfg = guidesConfig(root);
      const reply = await get((req, res) => void serveGuidesIndex(cfg, res));
      assert.strictEqual(reply.status, 200);
      assert.strictEqual(reply.headers['cache-control'], 'no-store');
      const body = JSON.parse(reply.body);
      assert.strictEqual(body.decks.length, 2);
      assert.strictEqual(body.guides.length, 1);
      assert.strictEqual('error' in body, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('serveGuidesIndex: a missing guidesDir is still 200 with empty arrays, no error flag', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'));
    try {
      const cfg = guidesConfig(path.join(root, 'does-not-exist'));
      const reply = await get((req, res) => void serveGuidesIndex(cfg, res));
      assert.strictEqual(reply.status, 200);
      const body = JSON.parse(reply.body);
      assert.deepStrictEqual(body.decks, []);
      assert.deepStrictEqual(body.guides, []);
      assert.strictEqual('error' in body, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  /* ---------------------------------------------------------- Task 4: serveGuideFile */

  if (await test('serveGuideFile: 200 with the file bytes and Content-Type text/html; charset=utf-8', async () => {
    const root = makeGuidesFixture();
    try {
      const cfg = guidesConfig(root);
      const reply = await get((req, res) => void serveGuideFile(cfg, 'tutor/a-deck.html', res));
      assert.strictEqual(reply.status, 200);
      assert.strictEqual(reply.headers['content-type'], 'text/html; charset=utf-8');
      assert.strictEqual(reply.headers['cache-control'], 'no-store');
      assert.ok(reply.body.includes('tutor-deck'), 'expected the tutor-deck marker in the served bytes');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('serveGuideFile: a relPath with a literal ".." segment is rejected — 404 { error: "not found" }, no file content', async () => {
    // Weaker than it looks, so read this before trusting it: this exercises
    // resolveGuidePath's cheap string-based segment reject, which runs on the
    // raw relPath before any filesystem call — a different, earlier-firing
    // mechanism than the realpath-based symlink-escape check the next test
    // covers. '../.env' resolves to os.tmpdir()/.env, which makeGuidesFixture
    // never creates, so this case would ALSO 404 (via ENOENT in the catch
    // below) even if the guard did nothing at all — it cannot by itself tell
    // "rejected" apart from "absent, and nothing happened to be there". Kept
    // because it documents the string-reject path's response shape (still a
    // real, distinct mechanism worth a regression test); the next test is
    // the one that actually proves the guard is load-bearing.
    const root = makeGuidesFixture();
    try {
      const cfg = guidesConfig(root);
      const reply = await get((req, res) => void serveGuideFile(cfg, '../.env', res));
      assert.strictEqual(reply.status, 404);
      assert.deepStrictEqual(JSON.parse(reply.body), { error: 'not found' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('serveGuideFile: the symlink-escape decoy (tutor/escape.html) is rejected — the case that actually proves the guard is load-bearing', async () => {
    // Unlike '../.env' above, this target is real: makeGuidesFixture (:212)
    // plants tutor/escape.html as a symlink to a real, readable file outside
    // the fixture root entirely (makeOutsideFile's '<title>secret</title>').
    // So if resolveGuidePath's realpath+prefix check were ever removed or
    // broken, this request would actually succeed in reading that file — a
    // genuine 200 with leaked content, not a coincidental ENOENT. That is
    // what makes this assertion non-vacuous, unlike the '../.env' case above
    // — confirmed by deliberately breaking the guard and watching this case
    // (and only this case) fail; see the fix report for the measurement.
    const root = makeGuidesFixture();
    try {
      const cfg = guidesConfig(root);
      const reply = await get((req, res) => void serveGuideFile(cfg, 'tutor/escape.html', res));
      assert.strictEqual(reply.status, 404);
      assert.deepStrictEqual(JSON.parse(reply.body), { error: 'not found' });
      assert.ok(!reply.body.includes('secret'), "must never leak the outside file's real content");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  if (await test('the /guides/<rest> route glue: a percent-encoded ".." segment is rejected, never 200, never leaks .env', async () => {
    // Mirrors server/index.ts's route glue exactly (see the comment there):
    // slice off the '/guides/' prefix, decodePath it, then serveGuideFile.
    // `new URL()` normalizes a LITERAL ".." segment away before `u.pathname`
    // is ever read (so `/guides/../.env` arrives as `/.env` and never reaches
    // this code at all) but does NOT normalize a percent-encoded one — so
    // `..%2f.env` is the shape that actually has to be rejected here. Same
    // caveat as the literal-".." case above applies: the decoded target
    // (../.env) doesn't exist either, so this proves the URL-decoding step
    // composes correctly with the segment-reject path, not that the guard is
    // load-bearing — that proof lives in the escape.html case above.
    const root = makeGuidesFixture();
    try {
      const cfg = guidesConfig(root);
      const reply = await get((req, res) => {
        const u = new URL(req.url || '/', 'http://local');
        const relPath = decodePath(u.pathname.slice('/guides/'.length));
        if (relPath === null) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'bad path encoding' }));
          return;
        }
        void serveGuideFile(cfg, relPath, res);
      }, '/guides/..%2f.env');
      assert.ok(reply.status === 400 || reply.status === 404, `expected 400 or 404, got ${reply.status}`);
      assert.ok(!/ANSWER_TOKEN|NTFY_TOPIC/.test(reply.body), 'must never leak .env content');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  for (const dir of outsideDirs) fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
