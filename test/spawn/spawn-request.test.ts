/**
 * The launch sheet's default permission mode and request assembly (client/src/lib/spawnOptions.ts `defaultPermissionMode`, `buildSpawnRequest`).
 */
import assert from 'node:assert';

import { allowedPermissionModes, buildSpawnRequest, defaultPermissionMode, type SpawnForm } from '../../client/src/lib/spawnOptions.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const FORM: SpawnForm = {
  project: '-p-a', prompt: 'do it', name: '', model: '', effort: '', permissionMode: 'auto', desktop: false, remoteControl: true, oneShot: false,
};

export function run(): number {
  console.log('\n=== spawn request (client/src/lib/spawnOptions.ts) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test("default mode: 'auto' when allowed, otherwise the ceiling", () => {
    assert.strictEqual(defaultPermissionMode(allowedPermissionModes(undefined)), 'auto');
    assert.strictEqual(defaultPermissionMode(allowedPermissionModes('bypassPermissions')), 'auto');
    assert.strictEqual(defaultPermissionMode(allowedPermissionModes('acceptEdits')), 'acceptEdits');
    assert.strictEqual(defaultPermissionMode(allowedPermissionModes('plan')), 'plan');
  }));

  tally(test('a plain dashboard launch: trimmed prompt, the picked mode, remote control as set, no optional keys', () => {
    assert.deepStrictEqual(buildSpawnRequest({ ...FORM, prompt: '  do it \n' }),
      { project: '-p-a', prompt: 'do it', permissionMode: 'auto', remoteControl: true });
  }));

  tally(test('name is trimmed, and a whitespace-only name is left out', () => {
    assert.strictEqual(buildSpawnRequest({ ...FORM, name: '  fixer  ' }).name, 'fixer');
    assert.ok(!('name' in buildSpawnRequest({ ...FORM, name: '   ' })));
  }));

  tally(test('model and effort are sent only when picked; oneShot only when on', () => {
    const req = buildSpawnRequest({ ...FORM, model: 'opus', effort: 'high', oneShot: true, remoteControl: false });
    assert.deepStrictEqual(req, { project: '-p-a', prompt: 'do it', permissionMode: 'auto', remoteControl: false, model: 'opus', effort: 'high', oneShot: true });
  }));

  tally(test('desktop forces remoteControl: false and oneShot: true, whatever the toggles held, and names the surface', () => {
    const req = buildSpawnRequest({ ...FORM, desktop: true, remoteControl: true, oneShot: false });
    assert.strictEqual(req.surface, 'desktop');
    assert.strictEqual(req.remoteControl, false);
    assert.strictEqual(req.oneShot, true);
    assert.ok(!('surface' in buildSpawnRequest(FORM)), 'a dashboard launch carries no surface');
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
