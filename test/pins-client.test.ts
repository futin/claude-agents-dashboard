import assert from 'node:assert';

import { applyPinOrder, dropIndex, matchesPinFilter, movePin, shortenHome, splitPath } from '../client/src/lib/pins.js';
import type { PinRect } from '../client/src/lib/pins.js';
import type { ProjectRef } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** One item at `{left, top}` sized `w` x `h`, as `dropIndex` reads it. */
function at(name: string, left: number, top: number, w: number, h: number): { name: string; rect: PinRect } {
  return { name, rect: { left, top, right: left + w, bottom: top + h } };
}

/** `names` laid out in reading order over `cols` columns at lefts 0/110/220…, width 100, rows 90 apart, height 80 — the grid case from #193's plan. */
function grid(names: readonly string[], cols: number): { name: string; rect: PinRect }[] {
  return names.map((n, i) => at(n, (i % cols) * 110, Math.floor(i / cols) * 90, 100, 80));
}

function ref(name: string, path: string): ProjectRef {
  return { dirName: path.replace(/[^A-Za-z0-9]/g, '-'), name, path, lastActiveMs: 0 };
}

export function run(): number {
  console.log('\n=== pins.ts (client) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

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

  const abcd = ['a', 'b', 'c', 'd'];

  tally(test('movePin: moves a name so it sits at toIndex in the result, without touching the input', () => {
    const input = [...abcd];
    assert.deepStrictEqual(movePin(input, 'd', 0), ['d', 'a', 'b', 'c']);
    assert.deepStrictEqual(movePin(input, 'a', 3), ['b', 'c', 'd', 'a']);
    assert.deepStrictEqual(movePin(input, 'b', 2), ['a', 'c', 'b', 'd']);
    assert.deepStrictEqual(movePin(input, 'c', 1), ['a', 'c', 'b', 'd']);
    assert.deepStrictEqual(input, abcd, 'the input is not mutated');
  }));

  tally(test('movePin: clamps toIndex to the list', () => {
    assert.deepStrictEqual(movePin(abcd, 'a', 99), ['b', 'c', 'd', 'a']);
    assert.deepStrictEqual(movePin(abcd, 'd', -5), ['d', 'a', 'b', 'c']);
  }));

  tally(test('movePin: no move, or an unknown name, returns the input itself', () => {
    assert.strictEqual(movePin(abcd, 'b', 1), abcd, 'already there');
    assert.strictEqual(movePin(abcd, 'x', 0), abcd, 'unknown name');
    assert.strictEqual(movePin(abcd, 'x', 99), abcd, 'not-found wins over clamping');
    assert.strictEqual(movePin(abcd, 'd', 99), abcd, 'clamps to its own index');
  }));

  tally(test('applyPinOrder: rows re-sorted into the order, the same objects in a new array', () => {
    const rows = ['a', 'b', 'c'].map(dirName => ({ dirName }));
    const got = applyPinOrder(rows, ['c', 'a', 'b']);
    assert.deepStrictEqual(got.map(r => r.dirName), ['c', 'a', 'b']);
    got.forEach(r => assert.strictEqual(r, rows.find(x => x.dirName === r.dirName)));
    const same = applyPinOrder(rows, ['a', 'b', 'c']);
    assert.deepStrictEqual(same.map(r => r.dirName), ['a', 'b', 'c']);
    assert.notStrictEqual(same, rows, 'a new array');
  }));

  tally(test('applyPinOrder: never drops or duplicates a row when the order and the rows disagree', () => {
    const rows = ['a', 'b', 'c'].map(dirName => ({ dirName }));
    assert.deepStrictEqual(applyPinOrder(rows, ['c', 'a']).map(r => r.dirName), ['c', 'a', 'b'], 'an unnamed row is kept, after');
    assert.deepStrictEqual(applyPinOrder(rows.slice(0, 2), ['b', 'x', 'a']).map(r => r.dirName), ['b', 'a'], 'an unknown name is skipped');
    assert.deepStrictEqual(applyPinOrder([], ['a']), []);
  }));

  // A, B, C, D stacked: tops 0/40/80/120, height 40, so midpoints 20/60/100/140.
  const column = ['A', 'B', 'C', 'D'].map((n, i) => at(n, 0, i * 40, 300, 40));

  tally(test('dropIndex, one column: the count of other items whose vertical midpoint is above the pointer', () => {
    assert.strictEqual(dropIndex(column, 'B', { x: 10, y: 50 }), 1, 'unchanged');
    assert.strictEqual(dropIndex(column, 'B', { x: 10, y: 15 }), 0);
    assert.strictEqual(dropIndex(column, 'B', { x: 10, y: 101 }), 2, "past C's midpoint 100");
    assert.strictEqual(dropIndex(column, 'B', { x: 10, y: 100 }), 1, 'exactly on a midpoint does not cross it');
    assert.strictEqual(dropIndex(column, 'B', { x: 10, y: 500 }), 3);
    assert.strictEqual(dropIndex(column, 'B', { x: 10, y: -50 }), 0);
  }));

  tally(test('dropIndex, one column: x is ignored', () => {
    assert.strictEqual(dropIndex(column, 'B', { x: -1000, y: 101 }), 2);
    assert.strictEqual(dropIndex(column, 'B', { x: 5000, y: 101 }), 2);
  }));

  const six = grid(['A', 'B', 'C', 'D', 'E', 'F'], 3);

  tally(test('dropIndex, grid: rows wholly above count, and in the pointer\'s row items whose midX it has passed', () => {
    assert.strictEqual(dropIndex(six, 'C', { x: 30, y: 120 }), 2, "A and B above; D's midX 50 not passed");
    assert.strictEqual(dropIndex(six, 'C', { x: 60, y: 120 }), 3);
    assert.strictEqual(dropIndex(six, 'C', { x: 280, y: 120 }), 5);
    assert.strictEqual(dropIndex(six, 'C', { x: 10, y: 40 }), 0);
    assert.strictEqual(dropIndex(six, 'C', { x: 60, y: 40 }), 1);
    assert.strictEqual(dropIndex(six, 'C', { x: 200, y: 85 }), 2, 'in the row gap: A and B only');
    assert.strictEqual(dropIndex(six, 'C', { x: 0, y: 500 }), 5);
  }));

  tally(test('dropIndex, grid: an applied result is stable under a still pointer', () => {
    const order = ['A', 'B', 'C', 'D', 'E', 'F'];
    const moved = movePin(order, 'C', dropIndex(six, 'C', { x: 60, y: 120 }));
    assert.deepStrictEqual(moved, ['A', 'B', 'D', 'C', 'E', 'F']);
    const relaid = grid(moved, 3);
    const again = dropIndex(relaid, 'C', { x: 60, y: 120 });
    assert.strictEqual(again, 3);
    assert.strictEqual(movePin(moved, 'C', again), moved, 'the same reference: nothing re-renders');
  }));

  tally(test('dropIndex, grid: a partial last row', () => {
    const five = grid(['A', 'B', 'C', 'D', 'E'], 3);
    assert.strictEqual(dropIndex(five, 'A', { x: 0, y: 500 }), 4);
    assert.strictEqual(dropIndex(five, 'A', { x: 170, y: 120 }), 4, 'D (midX 50) and E (midX 160) both passed');
  }));

  tally(test('dropIndex: edge cases', () => {
    assert.strictEqual(dropIndex([at('A', 0, 0, 100, 40)], 'A', { x: 999, y: 999 }), 0, 'only the dragged item');
    assert.strictEqual(dropIndex([], 'A', { x: 0, y: 0 }), -1, 'empty list');
    assert.strictEqual(dropIndex(column, 'X', { x: 0, y: 50 }), -1, 'dragged name not in the list');
    const phone = ['A', 'B', 'C'].map((n, i) => at(n, 0, i * 100, 340, 90));
    assert.strictEqual(dropIndex(phone, 'A', { x: 330, y: 160 }), 1, 'Tiles at phone width: all at left 0, the one-column rule');
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
