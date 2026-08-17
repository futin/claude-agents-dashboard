import assert from 'node:assert';

import {
  EFFORTS, MODELS, NAME_CAP, PERMISSION_MODE_LABEL, PERMISSION_MODES, PROMPT_CAP,
  allowedPermissionModes
} from '../client/src/lib/spawnOptions.js';
import {
  EFFORTS as SERVER_EFFORTS, MODELS as SERVER_MODELS, NAME_CAP as SERVER_NAME_CAP,
  PERMISSION_MODES as SERVER_PERMISSION_MODES, PROMPT_CAP as SERVER_PROMPT_CAP
} from '../server/lib/spawn.js';
import type { PermissionMode } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== spawnOptions.ts (client) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  /* ------------------------------------------------ parity with server/lib/spawn.ts
     The whole point of this file: a client array the server's own list
     drifted away from is a failing test here, not a silent surprise a user
     finds by picking an option that gets dropped. */

  check(test('MODELS matches server/lib/spawn.ts byte-for-byte', () => {
    assert.deepStrictEqual(MODELS, SERVER_MODELS);
  }));

  check(test('EFFORTS matches server/lib/spawn.ts byte-for-byte', () => {
    assert.deepStrictEqual(EFFORTS, SERVER_EFFORTS);
  }));

  check(test('PERMISSION_MODES matches server/lib/spawn.ts byte-for-byte, same order', () => {
    assert.deepStrictEqual(PERMISSION_MODES, SERVER_PERMISSION_MODES);
  }));

  check(test('NAME_CAP matches server/lib/spawn.ts', () => {
    assert.strictEqual(NAME_CAP, SERVER_NAME_CAP);
  }));

  check(test('PROMPT_CAP matches server/lib/spawn.ts', () => {
    assert.strictEqual(PROMPT_CAP, SERVER_PROMPT_CAP);
  }));

  /* ---------------------------------------------------------- PERMISSION_MODE_LABEL */

  check(test('every PERMISSION_MODES value has a label — none render blank in the select', () => {
    for (const mode of PERMISSION_MODES) {
      assert.ok(PERMISSION_MODE_LABEL[mode], `missing label for ${mode}`);
    }
  }));

  /* ------------------------------------------------------------ allowedPermissionModes */

  check(test('no ceiling (health not yet loaded, or an older server): up to auto, never bypass', () => {
    assert.deepStrictEqual(allowedPermissionModes(undefined), ['plan', 'acceptEdits', 'auto']);
  }));

  check(test('ceiling plan: only plan', () => {
    assert.deepStrictEqual(allowedPermissionModes('plan'), ['plan']);
  }));

  check(test('ceiling acceptEdits: plan and acceptEdits', () => {
    assert.deepStrictEqual(allowedPermissionModes('acceptEdits'), ['plan', 'acceptEdits']);
  }));

  check(test('ceiling auto (the server default): up to auto', () => {
    assert.deepStrictEqual(allowedPermissionModes('auto'), ['plan', 'acceptEdits', 'auto']);
  }));

  check(test('ceiling bypassPermissions (host opted in): all four, in ladder order', () => {
    assert.deepStrictEqual(allowedPermissionModes('bypassPermissions'), ['plan', 'acceptEdits', 'auto', 'bypassPermissions']);
  }));

  check(test('an unrecognized ceiling falls back to auto, never to the top of the ladder', () => {
    assert.deepStrictEqual(allowedPermissionModes('nonsense' as PermissionMode), ['plan', 'acceptEdits', 'auto']);
  }));

  check(test('the result always ends on the (validated) ceiling itself', () => {
    for (const ceiling of PERMISSION_MODES) {
      const allowed = allowedPermissionModes(ceiling);
      assert.strictEqual(allowed[allowed.length - 1], ceiling);
    }
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
