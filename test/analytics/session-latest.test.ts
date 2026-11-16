// `resolveLatest` (scripts/lib/latest-session.ts), the resolver behind `pnpm session-analytics --latest`: which transcript it picks for a cwd and how
// many candidates it parsed in full to decide (`fullParses`). The same cases run against kaizen's twin in plugin/skills/kaizen/test/latest.test.mjs,
// with that side's 64 KiB window; this side's window is server/lib/transcript.ts's HEAD_BYTES, the one `launchCwd` reads.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveLatest } from '../../scripts/lib/latest-session.js';
import { HEAD_BYTES } from '../../server/lib/transcript.js';

const W = HEAD_BYTES;

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const dirs: string[] = [];

function world(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-latest-'));
  dirs.push(home);
  const root = path.join(home, '.claude', 'projects');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

let seq = 0;
const T0 = Date.parse('2026-11-01T00:00:00Z') / 1000;

/** Write `records` as one transcript under the project dir for `dirCwd`, with mtime T0 + `age` seconds. */
function transcript(root: string, dirCwd: string, records: unknown[], age: number, raw?: string): { id: string; file: string } {
  const dir = path.join(root, dirCwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const id = `s${String(seq++).padStart(4, '0')}`;
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, raw ?? records.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, T0 + age, T0 + age);
  return { id, file };
}

function rec(cwd: string | undefined, extra: Record<string, unknown> = {}) {
  return { type: 'user', ...(cwd === undefined ? {} : { cwd }), timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'go' }, ...extra };
}

/** A first record with no `cwd` key whose serialised line is exactly `bytes` long. */
function padding(bytes: number) {
  const base = { type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: '' } };
  const overhead = JSON.stringify(base).length;
  return { ...base, message: { role: 'user', content: 'x'.repeat(bytes - overhead) } };
}

const normal = (root: string, cwd: string, age: number) => transcript(root, cwd, [rec(cwd), rec(cwd)], age);

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  console.log('\nsession-latest');

  t('1. an older match behind newer foreign sessions, with no full parse', () => {
    const root = world();
    for (let i = 0; i < 3; i++) normal(root, '/w/a', 100 + i);
    const b = normal(root, '/w/b', 10);
    const r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, b.id);
    assert.strictEqual(r.match?.file, b.file);
    assert.strictEqual(r.fullParses, 0);
  });

  t('2. the newest of several transcripts in the same cwd', () => {
    const root = world();
    normal(root, '/w/b', 0);
    const bNew = normal(root, '/w/b', 60);
    const r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, bNew.id);
    assert.strictEqual(r.fullParses, 0);
  });

  t('3. a trailing slash on either side still matches; / matches only /', () => {
    let root = world();
    let x = transcript(root, '/x/proj', [rec('/x/proj/')], 0);
    assert.strictEqual(resolveLatest({ root, cwd: '/x/proj' }).match?.id, x.id);
    root = world();
    x = transcript(root, '/x/proj', [rec('/x/proj')], 0);
    assert.strictEqual(resolveLatest({ root, cwd: '/x/proj/' }).match?.id, x.id);
    root = world();
    x = transcript(root, '/', [rec('/')], 0);
    assert.strictEqual(resolveLatest({ root, cwd: '/' }).match?.id, x.id);
    assert.strictEqual(resolveLatest({ root, cwd: '/x' }).match, null);
    root = world();
    transcript(root, '/x', [rec('/x/')], 0);
    assert.strictEqual(resolveLatest({ root, cwd: '/' }).match, null);
  });

  t('4. no match reads heads only — never a full parse', () => {
    const root = world();
    for (let i = 0; i < 5; i++) normal(root, `/w/other${i}`, i);
    assert.deepStrictEqual(resolveLatest({ root, cwd: '/w/b' }), { match: null, fullParses: 0 });
  });

  t('5. the first cwd decides, not any later one', () => {
    let root = world();
    transcript(root, '/w/a', [rec('/w/a'), rec('/w/b')], 100);
    const older = normal(root, '/w/b', 10);
    let r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, older.id);
    assert.strictEqual(r.fullParses, 0);
    root = world();
    transcript(root, '/w/a', [rec('/w/a'), rec('/w/b')], 100);
    r = resolveLatest({ root, cwd: '/w/b' });
    assert.deepStrictEqual(r, { match: null, fullParses: 0 });
  });

  t('6. fallback: the first cwd sits past the window', () => {
    const root = world();
    const x = transcript(root, '/w/b', [padding(W + 5000), rec('/w/b')], 0);
    const r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, x.id);
    assert.strictEqual(r.fullParses, 1);
  });

  t('7. fallback: the cwd record straddles the window edge', () => {
    const root = world();
    const cwdRec = rec('/w/b', { message: { role: 'user', content: 'y'.repeat(300) } });
    const x = transcript(root, '/w/b', [padding(W - 100 - 1), cwdRec], 0);
    assert.strictEqual(fs.readFileSync(x.file, 'utf8').indexOf('{"type":"user","cwd"'), W - 100);
    assert.ok(W - 100 + JSON.stringify(cwdRec).length > W);
    const r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, x.id);
    assert.strictEqual(r.fullParses, 1);
  });

  t('8. a fallback on a foreign file costs one parse and does not match', () => {
    const root = world();
    transcript(root, '/w/a', [padding(W + 5000), rec('/w/a')], 100);
    const b = normal(root, '/w/b', 10);
    const r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, b.id);
    assert.strictEqual(r.fullParses, 1);
  });

  t('9. no cwd anywhere: a small file costs no parse, a big one costs one', () => {
    let root = world();
    transcript(root, '/w/none', [rec(undefined), rec(undefined)], 100);
    let b = normal(root, '/w/b', 10);
    let r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, b.id);
    assert.strictEqual(r.fullParses, 0);
    root = world();
    transcript(root, '/w/none', [padding(W + 5000), rec(undefined)], 100);
    b = normal(root, '/w/b', 10);
    r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, b.id);
    assert.strictEqual(r.fullParses, 1);
    root = world();
    transcript(root, '/w/none', [rec(undefined), rec(undefined)], 100);
    transcript(root, '/w/none2', [padding(W + 5000), rec(undefined)], 90);
    b = normal(root, '/w/b', 10);
    r = resolveLatest({ root, cwd: '/w/b' });
    assert.strictEqual(r.match?.id, b.id);
    assert.strictEqual(r.fullParses, 1);
  });

  t('10. empty and unreadable files are skipped without throwing', () => {
    const root = world();
    transcript(root, '/w/b', [], 100, '');
    const locked = process.getuid?.() === 0 ? null : transcript(root, '/w/b', [rec('/w/b')], 90);
    if (locked) fs.chmodSync(locked.file, 0o000);
    const b = normal(root, '/w/b', 10);
    try {
      const r = resolveLatest({ root, cwd: '/w/b' });
      assert.strictEqual(r.match?.id, b.id);
      assert.strictEqual(r.fullParses, 0);
    } finally {
      if (locked) fs.chmodSync(locked.file, 0o644);
    }
  });

  t('11. an empty or missing root', () => {
    const root = world();
    assert.deepStrictEqual(resolveLatest({ root, cwd: '/w/b' }), { match: null, fullParses: 0 });
    assert.deepStrictEqual(resolveLatest({ root: path.join(root, 'nope'), cwd: '/w/b' }), { match: null, fullParses: 0 });
  });

  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
