import assert from 'node:assert';

import { matchesPinFilter, pinnedOptionLabel, shortenHome, splitPath } from '../client/src/lib/pins.js';
import type { ProjectRef } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function ref(name: string, path: string, pinned?: true): ProjectRef {
  return { dirName: path.replace(/[^A-Za-z0-9]/g, '-'), name, path, lastActiveMs: 0, ...(pinned ? { pinned } : {}) };
}

export function run(): number {
  console.log('\n=== pins.ts (client) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test('option label: "· pinned" suffix only on a pinned ref', () => {
    assert.strictEqual(pinnedOptionLabel(ref('backlog-manager', '/x/backlog-manager', true)), 'backlog-manager · pinned');
    assert.strictEqual(pinnedOptionLabel(ref('backlog-manager', '/x/backlog-manager')), 'backlog-manager');
  }));

  tally(test('filter: matches name or path, case-insensitive; empty matches everything', () => {
    const gm = ref('guide-manager', '/Users/me/Documents/custom-projects/guide-manager');
    const other = ref('ixray', '/Users/me/src/ixray');
    assert.strictEqual(matchesPinFilter(gm, 'man'), true, 'by name');
    assert.strictEqual(matchesPinFilter(gm, 'custom-projects'), true, 'by path');
    assert.strictEqual(matchesPinFilter(gm, 'GUIDE'), true, 'case-insensitive');
    assert.strictEqual(matchesPinFilter(other, 'custom-projects'), false);
    assert.strictEqual(matchesPinFilter(other, '  '), true, 'a blank filter hides nothing');
  }));

  tally(test('shortenHome: home prefix becomes ~, anything else unchanged', () => {
    assert.strictEqual(shortenHome('/Users/me/Documents/x', '/Users/me'), '~/Documents/x');
    assert.strictEqual(shortenHome('/Users/me', '/Users/me'), '~');
    assert.strictEqual(shortenHome('/opt/x', '/Users/me'), '/opt/x');
    assert.strictEqual(shortenHome('/Users/meow/x', '/Users/me'), '/Users/meow/x', 'a prefix is not a parent');
    assert.strictEqual(shortenHome('/Users/me/x', ''), '/Users/me/x', 'no home known');
  }));

  tally(test('filter: a dead pin has no path — it matches by name only', () => {
    assert.strictEqual(matchesPinFilter({ name: 'old-worktree', path: null }, 'old'), true);
    assert.strictEqual(matchesPinFilter({ name: 'old-worktree', path: null }, 'Documents'), false);
    assert.strictEqual(matchesPinFilter({ name: 'old-worktree', path: null }, ''), true, 'a blank filter hides nothing');
  }));

  tally(test('splitPath: parent segments each keep their slash, the basename stands alone', () => {
    assert.deepStrictEqual(splitPath('~/Documents/custom-projects/claude-agents-dashboard'),
      { dirs: ['~/', 'Documents/', 'custom-projects/'], name: 'claude-agents-dashboard' });
    assert.deepStrictEqual(splitPath('/opt/x'), { dirs: ['/', 'opt/'], name: 'x' });
  }));

  tally(test('splitPath: a bare name has no parents; the root has no name', () => {
    assert.deepStrictEqual(splitPath('~'), { dirs: [], name: '~' });
    assert.deepStrictEqual(splitPath('/'), { dirs: ['/'], name: '' });
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
