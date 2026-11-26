/**
 * `scripts/session-analytics.ts`'s id resolution is `serveSessionDetail`'s: a worktree session whose transcript is split across two project dirs resolves
 * to the half the API serves (the newest), not to whichever `readdir` yields first (#580).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSessionId } from '../../scripts/session-analytics.js';
import { resetListingCache, resolveTranscript } from '../../server/lib/transcript-listing.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function half(root: string, dirName: string, id: string, ageMs: number): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/x', timestamp: new Date().toISOString() }) + '\n');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

export function run(): number {
  console.log('\n=== session-analytics id resolution ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-resolve-'));
  const id = '0f0f0f0f-1111-4222-8333-444444444444';

  t('a split session resolves to the newest half, the same file serveSessionDetail serves', () => {
    // The abandoned half sits in the dir that sorts (and so reads) first.
    half(root, '-a-repo', id, 60 * 60_000);
    const live = half(root, '-b-repo-worktree', id, 1_000);
    resetListingCache();
    assert.strictEqual(resolveSessionId(id, root)?.file, live);
    assert.strictEqual(resolveSessionId(id, root)?.file, resolveTranscript(root, id)?.file);
  });

  t('an unknown id resolves to nothing', () => {
    assert.strictEqual(resolveSessionId('ffffffff-0000-4000-8000-000000000000', root), undefined);
  });

  resetListingCache();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
