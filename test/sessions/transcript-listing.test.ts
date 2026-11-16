import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findTranscript } from '../../server/lib/scan.js';
import {
  LISTING_MAX_AGE_MS, publishListing, resetListingCache, resolveTranscript, sharedListing
} from '../../server/lib/transcript-listing.js';
import type { TranscriptRef } from '../../server/lib/scan.js';

function test(name: string, fn: () => void): boolean {
  resetListingCache();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally { resetListingCache(); }
}

/** A tmpdir projects root; `write(dir, id)` plants one transcript and returns its path. */
function withRoot(fn: (root: string, write: (dir: string, id: string, text?: string, mtimeMs?: number) => string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-listing-'));
  const write = (dir: string, id: string, text = '{"type":"user"}\n', mtimeMs?: number): string => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const file = path.join(root, dir, id + '.jsonl');
    fs.writeFileSync(file, text);
    if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };
  try { fn(root, write); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const T = 1_700_000_000_000;

export function run(): number {
  console.log('\n=== transcript-listing.ts ===\n');
  let p = 0, f = 0;

  if (test('a second call inside the age returns the held array, without a new walk', () => {
    withRoot((root, write) => {
      write('-p', 'a');
      const first = sharedListing(root, T);
      write('-p', 'b');
      const second = sharedListing(root, T + 1000);
      assert.strictEqual(second, first, 'same instance');
      assert.deepStrictEqual(second.map(r => r.id), ['a'], 'the file added between the calls is not listed yet');
    });
  })) p++; else f++;

  if (test('a call past LISTING_MAX_AGE_MS walks again and sees the new file', () => {
    withRoot((root, write) => {
      write('-p', 'a');
      sharedListing(root, T);
      write('-p', 'b');
      const later = sharedListing(root, T + LISTING_MAX_AGE_MS + 1);
      assert.deepStrictEqual(later.map(r => r.id).sort(), ['a', 'b']);
    });
  })) p++; else f++;

  if (test('a published listing is served as is, with no disk read', () => {
    const root = path.join(os.tmpdir(), 'cad-listing-does-not-exist-' + process.pid);
    const refs: TranscriptRef[] = [{ file: path.join(root, '-p', 'x.jsonl'), dirName: '-p', id: 'x', mtimeMs: T, size: 1 }];
    publishListing(root, refs, T);
    assert.strictEqual(sharedListing(root, T + 100), refs);
  })) p++; else f++;

  if (test('a call for another root inside the age lists that root, never the held one', () => {
    withRoot((rootA, writeA) => {
      withRoot((rootB, writeB) => {
        writeA('-a', 'from-a');
        writeB('-b', 'from-b');
        sharedListing(rootA, T);
        assert.deepStrictEqual(sharedListing(rootB, T + 10).map(r => r.id), ['from-b']);
      });
    });
  })) p++; else f++;

  if (test('resolveTranscript stats the held ref again: size and mtime are current', () => {
    withRoot((root, write) => {
      const file = write('-p', 's', '{"a":1}\n', T - 60_000);
      sharedListing(root, T);
      fs.appendFileSync(file, '{"b":2}\n');
      fs.utimesSync(file, T / 1000, T / 1000);
      const ref = resolveTranscript(root, 's', T + 100);
      assert.ok(ref);
      assert.strictEqual(ref.size, fs.statSync(file).size);
      assert.strictEqual(ref.mtimeMs, fs.statSync(file).mtimeMs);
    });
  })) p++; else f++;

  if (test('resolveTranscript finds an id the held listing lacks through the name walk', () => {
    withRoot((root, write) => {
      write('-p', 'old');
      sharedListing(root, T);
      const file = write('-p', 'new');
      assert.strictEqual(resolveTranscript(root, 'new', T + 100)?.file, file);
    });
  })) p++; else f++;

  if (test('resolveTranscript answers undefined for a file deleted after the listing, without throwing', () => {
    withRoot((root, write) => {
      const file = write('-p', 'gone');
      sharedListing(root, T);
      fs.rmSync(file);
      assert.strictEqual(resolveTranscript(root, 'gone', T + 100), undefined);
    });
  })) p++; else f++;

  if (test('resolveTranscript serves the newer half of a split session, as findTranscript does', () => {
    withRoot((root, write) => {
      write('-main', 'split', '{"a":1}\n', T - 60_000);
      const newer = write('-main--worktree', 'split', '{"a":1}\n', T - 1000);
      sharedListing(root, T);
      assert.strictEqual(resolveTranscript(root, 'split', T + 100)?.file, newer);
      assert.strictEqual(findTranscript(root, 'split')?.file, newer);
    });
  })) p++; else f++;

  if (test('resolveTranscript answers undefined for an id on disk nowhere', () => {
    withRoot((root, write) => {
      write('-p', 'a');
      sharedListing(root, T);
      assert.strictEqual(resolveTranscript(root, 'nowhere', T + 100), undefined);
    });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
