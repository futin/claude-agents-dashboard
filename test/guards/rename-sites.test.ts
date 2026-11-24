/**
 * Every tmp-plus-rename under `server/` goes through `writeFileAtomic` (`server/lib/atomic-write.ts`), which removes its temp file on failure and names it
 * with the pid. Six hand copies had drifted from it (#553): some left the temp behind, one had no pid. This guard fails on the seventh — any rename call
 * outside the helper and the sites below, which are not tmp-plus-rename of a state file and stay out on purpose.
 *
 * Source text, not behaviour: what a new copy breaks is the one place the rule lives, and nothing at runtime notices a temp file left behind.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from './docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Rename calls allowed per file, repo-relative. Change a count only with the reason beside it. */
const ALLOWED: Record<string, number> = {
  // The helper itself: `(renameOverride ?? fs.renameSync)(tmp, file)`.
  'server/lib/atomic-write.ts': 1,
  // `writeJob`: a dotfile temp so a watcher never takes it for a job, and `create` goes through `linkSync`; and `removeIfStale` moving a file aside.
  'server/lib/routine-store.ts': 2,
  // Swaps a whole imported `jobs/` directory into place.
  'server/lib/routine-import.ts': 1,
  // Log rotation: renames existing numbered files.
  'server/lib/routine-log.ts': 1,
  // Moves the legacy state dir to `~/.claude/routines`, once.
  'server/lib/routine-config.ts': 1
};

/** A sync rename call, direct or through a seam (`renameSync(`, `fs.renameSync)(`), or an async `.rename(`. A comment naming `renameSync` is no call. */
const RENAME_CALL = /\brenameSync\s*\)?\s*\(|\.rename\s*\(/g;

export function countRenames(src: string): number {
  return src.match(RENAME_CALL)?.length ?? 0;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|mts|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function run(): number {
  console.log('\n=== rename sites: tmp-plus-rename goes through writeFileAtomic ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  if (test('the counter sees direct, seam and async rename calls, and not a comment that names renameSync', () => {
    assert.strictEqual(countRenames('fs.renameSync(tmp, file);'), 1);
    assert.strictEqual(countRenames('(renameOverride ?? fs.renameSync)(tmp, file);'), 1);
    assert.strictEqual(countRenames('await fs.promises.rename(tmp, file);'), 1);
    assert.strictEqual(countRenames('/** Null restores `fs.renameSync`. */'), 0);
  })) p++; else f++;

  if (test('rename calls under server/ appear only in atomic-write.ts and the allowlisted sites, at their counts', () => {
    const found: Record<string, number> = {};
    for (const file of walk(path.join(root, 'server'))) {
      const n = countRenames(fs.readFileSync(file, 'utf8'));
      if (n > 0) found[path.relative(root, file).split(path.sep).join('/')] = n;
    }
    assert.deepStrictEqual(found, ALLOWED,
      'a new tmp-plus-rename belongs in writeFileAtomic (server/lib/atomic-write.ts); a rename of another kind goes in ALLOWED with its reason');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
