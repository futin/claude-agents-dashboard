import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cachedEntries, dirCacheStats, resetDirCache, RACY_MS } from '../../server/lib/dir-cache.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Move a dir's mtime 10 s into the past, so a listing taken now is outside {@link RACY_MS} and may be served from the cache. */
function age(dir: string): void {
  const t = (Date.now() - 10_000) / 1000;
  fs.utimesSync(dir, t, t);
}

/** A fresh dir holding `a.jsonl` and the sub-dir `s/`. */
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-dc-'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n');
  fs.mkdirSync(path.join(dir, 's'));
  return dir;
}

const sorted = (entries: readonly { name: string; isDir: boolean }[]) => [...entries].sort((x, y) => x.name.localeCompare(y.name));

export function run(): number {
  console.log('\n=== dir-cache.ts ===\n');
  let p = 0, f = 0;

  if (test('RACY_MS is 2 s', () => {
    assert.strictEqual(RACY_MS, 2000);
  })) p++; else f++;

  if (test('a cold call returns every entry with its kind and reads the dir once', () => {
    resetDirCache();
    const dir = fixture();
    const out = cachedEntries(dir);
    assert.deepStrictEqual(sorted(out), [{ name: 'a.jsonl', isDir: false }, { name: 's', isDir: true }]);
    assert.strictEqual(dirCacheStats().readdirs, 1);
  })) p++; else f++;

  if (test('a dir whose mtime is past the racy window is read once across two calls', () => {
    resetDirCache();
    const dir = fixture();
    age(dir);
    const first = cachedEntries(dir);
    const second = cachedEntries(dir);
    assert.strictEqual(dirCacheStats().readdirs, 1);
    assert.deepStrictEqual(second, first);
  })) p++; else f++;

  if (test('mirror: a dir whose mtime is now (inside the racy window) is read on every call', () => {
    resetDirCache();
    const dir = fixture();
    cachedEntries(dir);
    cachedEntries(dir);
    assert.strictEqual(dirCacheStats().readdirs, 2);
  })) p++; else f++;

  if (test('an entry added to or removed from a warm dir shows on the next call', () => {
    resetDirCache();
    const dir = fixture();
    age(dir);
    cachedEntries(dir);
    cachedEntries(dir);
    assert.strictEqual(dirCacheStats().readdirs, 1, 'warm');
    fs.writeFileSync(path.join(dir, 'b.jsonl'), '{}\n');
    assert.ok(cachedEntries(dir).some(e => e.name === 'b.jsonl'), 'new file listed');
    fs.unlinkSync(path.join(dir, 'a.jsonl'));
    assert.ok(!cachedEntries(dir).some(e => e.name === 'a.jsonl'), 'deleted file gone');
  })) p++; else f++;

  if (test('a missing dir answers [] and holds nothing; a held dir that is removed answers [] and is dropped', () => {
    resetDirCache();
    const dir = fixture();
    assert.deepStrictEqual(cachedEntries(path.join(dir, 'no-such-dir')), []);
    assert.strictEqual(dirCacheStats().entries, 0);
    const gone = path.join(dir, 's');
    cachedEntries(gone);
    assert.strictEqual(dirCacheStats().entries, 1);
    fs.rmdirSync(gone);
    assert.deepStrictEqual(cachedEntries(gone), []);
    assert.strictEqual(dirCacheStats().entries, 0);
  })) p++; else f++;

  if (test('a file path answers [] and holds nothing', () => {
    resetDirCache();
    const dir = fixture();
    assert.deepStrictEqual(cachedEntries(path.join(dir, 'a.jsonl')), []);
    assert.strictEqual(dirCacheStats().entries, 0);
  })) p++; else f++;

  if (test('re-reading a parent drops the held listing of a child dir it no longer names', () => {
    resetDirCache();
    const parent = fixture();
    const child = path.join(parent, 's');
    age(child);
    age(parent);
    cachedEntries(parent);
    cachedEntries(child);
    assert.strictEqual(dirCacheStats().entries, 2);
    fs.rmdirSync(child);   // moves the parent's mtime
    cachedEntries(parent);
    assert.strictEqual(dirCacheStats().entries, 1);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
