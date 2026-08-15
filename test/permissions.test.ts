import assert from 'node:assert';

import {
  MESSAGE_CAP, clearPermission, notifyPermission, permissionMessage,
  permissionWaits, resetPermissions
} from '../server/lib/permissions.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(): Promise<number> {
  console.log('\n=== permissions.ts ===\n');
  let p = 0, f = 0;

  if (test('notify records the session with the injected timestamp', () => {
    resetPermissions();
    notifyPermission('sess-a', 'Claude needs your permission to use Bash', 60_000, 1_700_000_000_000);
    const waits = permissionWaits();
    assert.strictEqual(waits.size, 1);
    assert.strictEqual(waits.get('sess-a'), 1_700_000_000_000);
    assert.strictEqual(permissionMessage('sess-a'), 'Claude needs your permission to use Bash');
  })) p++; else f++;

  if (test('re-notify supersedes: one entry, newer timestamp, old timer dropped', () => {
    resetPermissions();
    notifyPermission('sess-a', 'first', 60_000, 1_000);
    notifyPermission('sess-a', 'second', 60_000, 2_000);
    const waits = permissionWaits();
    assert.strictEqual(waits.size, 1);
    assert.strictEqual(waits.get('sess-a'), 2_000);
    assert.strictEqual(permissionMessage('sess-a'), 'second');
  })) p++; else f++;

  if (test('a non-string message degrades to empty, never throws', () => {
    resetPermissions();
    notifyPermission('sess-a', undefined, 60_000, 1_000);
    notifyPermission('sess-b', { evil: true }, 60_000, 1_000);
    assert.strictEqual(permissionMessage('sess-a'), '');
    assert.strictEqual(permissionMessage('sess-b'), '');
    assert.strictEqual(permissionWaits().size, 2);
  })) p++; else f++;

  if (test('message is capped', () => {
    resetPermissions();
    notifyPermission('sess-a', 'x'.repeat(5_000), 60_000, 1_000);
    assert.strictEqual(permissionMessage('sess-a').length, MESSAGE_CAP);
  })) p++; else f++;

  if (test('permissionWaits returns a copy — mutating it cannot corrupt the store', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    const first = permissionWaits();
    first.delete('sess-a');
    first.set('ghost', 5);
    const second = permissionWaits();
    assert.strictEqual(second.size, 1);
    assert.strictEqual(second.get('sess-a'), 1_000);
  })) p++; else f++;

  if (test('unknown session reads as empty everywhere', () => {
    resetPermissions();
    assert.strictEqual(permissionWaits().get('nope'), undefined);
    assert.strictEqual(permissionMessage('nope'), '');
    clearPermission('nope'); // no-op, must not throw
  })) p++; else f++;

  if (test('clearPermission drops just that session', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    notifyPermission('sess-b', '', 60_000, 1_000);
    clearPermission('sess-a');
    const waits = permissionWaits();
    assert.strictEqual(waits.has('sess-a'), false);
    assert.strictEqual(waits.has('sess-b'), true);
  })) p++; else f++;

  // The TTL is only a backstop (the scan clears on transcript advance), but it
  // has to actually fire or a killed session keeps a pill forever.
  {
    const name = 'TTL expiry reaps the entry';
    resetPermissions();
    notifyPermission('sess-a', '', 20);
    await sleep(60);
    try {
      assert.strictEqual(permissionWaits().size, 0);
      console.log('  ✓ ' + name); p++;
    } catch (e) {
      console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); f++;
    }
  }

  {
    const name = 'a superseding notify re-arms the TTL instead of inheriting it';
    resetPermissions();
    notifyPermission('sess-a', '', 40);
    await sleep(25);
    notifyPermission('sess-a', '', 400);   // re-armed: the 40ms timer must not fire
    await sleep(40);
    try {
      assert.strictEqual(permissionWaits().has('sess-a'), true);
      console.log('  ✓ ' + name); p++;
    } catch (e) {
      console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); f++;
    }
    resetPermissions();
  }

  if (test('resetPermissions clears entries (and their timers)', () => {
    notifyPermission('sess-a', '', 60_000, 1_000);
    resetPermissions();
    assert.strictEqual(permissionWaits().size, 0);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
