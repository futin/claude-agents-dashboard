import assert from 'node:assert';

import {
  NAME_CAP, PROMPT_CAP,
  buildSpawnArgs, clampPermission, parseSpawnRequest
} from '../server/lib/spawn.js';
import type { PermissionMode } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Fixed test uuid — the exact value doesn't matter, only that it's echoed verbatim. */
const UUID = '11111111-1111-4111-8111-111111111111';

export function run(): number {
  console.log('\n=== spawn.ts ===\n');
  let p = 0, f = 0;

  /* -------------------------------------------------------------- constants */

  if (test('caps match the spec verbatim', () => {
    assert.strictEqual(PROMPT_CAP, 4000);
    assert.strictEqual(NAME_CAP, 60);
  })) p++; else f++;

  /* ------------------------------------------------------------ clampPermission */

  const LADDER: Array<{ requested: unknown; ceiling: unknown; expected: PermissionMode; why: string }> = [
    { requested: 'bypassPermissions', ceiling: 'auto', expected: 'auto',
      why: 'the browser cannot escalate past the host' },
    { requested: 'plan', ceiling: 'auto', expected: 'plan',
      why: 'asking for less than the ceiling is always allowed' },
    { requested: 'auto', ceiling: 'plan', expected: 'plan',
      why: 'a lowered ceiling lowers everything' },
    { requested: 'auto', ceiling: 'auto', expected: 'auto', why: 'equal is a no-op' },
    { requested: 'bypassPermissions', ceiling: 'bypassPermissions', expected: 'bypassPermissions',
      why: 'an opted-in host can reach the top' },
    { requested: 'nonsense', ceiling: 'auto', expected: 'auto',
      why: 'unknown request falls to the default, never to the top' },
    { requested: 'auto', ceiling: 'nonsense', expected: 'auto',
      why: 'unknown ceiling falls to the default, never to the top' },
    { requested: undefined, ceiling: 'plan', expected: 'plan',
      why: 'absent request defaults to auto, then clamps' }
  ];
  for (const { requested, ceiling, expected, why } of LADDER) {
    if (test(`clampPermission(${JSON.stringify(requested)}, ${JSON.stringify(ceiling)}) -> ${expected} (${why})`, () => {
      assert.strictEqual(clampPermission(requested, ceiling), expected);
    })) p++; else f++;
  }

  /* ------------------------------------------------------------ parseSpawnRequest */

  if (test('prompt is trimmed; permissionMode defaults to auto', () => {
    const r = parseSpawnRequest({ prompt: '  do it  ' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) {
      assert.strictEqual(r.input.prompt, 'do it');
      assert.strictEqual(r.input.permissionMode, 'auto');
    }
  })) p++; else f++;

  if (test('an empty or blank prompt is refused, naming the prompt', () => {
    for (const body of [{ prompt: '' }, { prompt: '   ' }]) {
      const r = parseSpawnRequest(body, 'auto');
      assert.strictEqual(r.ok, false);
      if (!r.ok) assert.match(r.error, /prompt/i);
    }
  })) p++; else f++;

  if (test('a 4000-char prompt is accepted — the cap is inclusive', () => {
    const r = parseSpawnRequest({ prompt: 'a'.repeat(4000) }, 'auto');
    assert.strictEqual(r.ok, true);
  })) p++; else f++;

  if (test('a 4001-char prompt is refused', () => {
    const r = parseSpawnRequest({ prompt: 'a'.repeat(4001) }, 'auto');
    assert.strictEqual(r.ok, false);
  })) p++; else f++;

  if (test('a non-object body (null, string, number) is refused', () => {
    for (const body of [null, 'a string', 42]) {
      assert.strictEqual(parseSpawnRequest(body, 'auto').ok, false);
    }
  })) p++; else f++;

  if (test('an unrecognized model is dropped, not fatal', () => {
    const r = parseSpawnRequest({ prompt: 'x', model: 'gpt-4' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.model, undefined);
  })) p++; else f++;

  if (test('a recognized model is kept', () => {
    const r = parseSpawnRequest({ prompt: 'x', model: 'opus' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.model, 'opus');
  })) p++; else f++;

  if (test('an unrecognized effort is dropped, not fatal', () => {
    const r = parseSpawnRequest({ prompt: 'x', effort: 'ludicrous' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.effort, undefined);
  })) p++; else f++;

  if (test('a name in the allowed charset is kept', () => {
    const r = parseSpawnRequest({ prompt: 'x', name: 'nightly build-2' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.name, 'nightly build-2');
  })) p++; else f++;

  if (test('a name outside the allowed charset is dropped', () => {
    const r = parseSpawnRequest({ prompt: 'x', name: 'x"; rm -rf /; echo "' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.name, undefined);
  })) p++; else f++;

  if (test('a name over NAME_CAP is dropped; exactly NAME_CAP is kept', () => {
    const over = parseSpawnRequest({ prompt: 'x', name: 'a'.repeat(61) }, 'auto');
    assert.ok(over.ok);
    if (over.ok) assert.strictEqual(over.input.name, undefined);

    const exact = parseSpawnRequest({ prompt: 'x', name: 'a'.repeat(60) }, 'auto');
    assert.ok(exact.ok);
    if (exact.ok) assert.strictEqual(exact.input.name, 'a'.repeat(60));
  })) p++; else f++;

  if (test('the ceiling clamps a requested permissionMode', () => {
    const r = parseSpawnRequest({ prompt: 'x', permissionMode: 'bypassPermissions' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.permissionMode, 'auto');
  })) p++; else f++;

  if (test('an unrecognized permissionMode clamps to the default', () => {
    const r = parseSpawnRequest({ prompt: 'x', permissionMode: 'manual' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.permissionMode, 'auto');
  })) p++; else f++;

  /* ------------------------------------------------------------ buildSpawnArgs */

  if (test('minimal input builds exactly the five fixed elements', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto']);
    assert.strictEqual(args.length, 5);
  })) p++; else f++;

  if (test('no argv element carries the prompt text (stdin regression guard)', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto' });
    assert.ok(args.every(a => !a.includes('hi')));
  })) p++; else f++;

  if (test('a model appends --model as its own pair', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', model: 'opus' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '--model', 'opus']);
  })) p++; else f++;

  if (test('an effort appends --effort as its own pair', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', effort: 'high' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '--effort', 'high']);
  })) p++; else f++;

  if (test('a name appends -n as one array element, not split on its space', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', name: 'nightly build' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '-n', 'nightly build']);
    assert.strictEqual(args[args.length - 1], 'nightly build');
    assert.strictEqual(args.length, 7);
  })) p++; else f++;

  // NOTE ON THE COUNT: the brief's Step 1 table claims length 13 for "all
  // three optional knobs at once." SpawnInput has exactly three optional
  // fields — name, model, effort — each contributing one 2-element flag pair
  // on top of the always-present 5-element base (`-p`, the `--session-id`
  // pair, the `--permission-mode` pair). That arithmetic is 5 + 2*3 = 11, not
  // 13; reaching 13 would need a fourth optional flag pair that doesn't exist
  // anywhere in SpawnInput or in this module. This looks like the brief
  // double-counting `--permission-mode`'s pair (once as part of the 5-element
  // base, again as one of "four knobs"). Asserting the internally-consistent
  // value (11) here — see the task report for the full disagreement.
  if (test('all three optional knobs together: fixed order, 11 elements total', () => {
    const args = buildSpawnArgs({
      sessionId: UUID, prompt: 'hi', permissionMode: 'auto',
      model: 'opus', effort: 'high', name: 'nightly build'
    });
    assert.deepStrictEqual(args, [
      '-p', '--session-id', UUID, '--permission-mode', 'auto',
      '--model', 'opus', '--effort', 'high', '-n', 'nightly build'
    ]);
    assert.strictEqual(args.length, 11);

    // flag order is stable across repeated calls with the same input
    const again = buildSpawnArgs({
      sessionId: UUID, prompt: 'hi', permissionMode: 'auto',
      model: 'opus', effort: 'high', name: 'nightly build'
    });
    assert.deepStrictEqual(again, args);
  })) p++; else f++;

  if (test('empty-string knobs are absent, not empty flag values', () => {
    const args = buildSpawnArgs({
      sessionId: UUID, prompt: 'hi', permissionMode: 'auto', model: '', effort: '', name: ''
    });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto']);
    assert.strictEqual(args.length, 5);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
