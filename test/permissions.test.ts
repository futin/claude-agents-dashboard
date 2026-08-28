import assert from 'node:assert';

import {
  MESSAGE_CAP, PERMISSION_PUSH_DEDUPE_MS, TERMINAL_HANDOFF_MS, clearPermission,
  handedToTerminal, noteTerminalHandoff, notifyPermission, permissionMessage,
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

  // --- push dedupe: two hooks, one dialog ---------------------------------
  //
  // `permission-notify.sh` is registered on BOTH `PermissionRequest` and
  // `Notification`, which fire ~6s apart for the same dialog. The store has
  // always coped (one entry, re-armed), but the caller also pushes, and two
  // POSTs meant two buzzes. The return value is what lets the route push once.

  if (test('first notify for a session is fresh', () => {
    resetPermissions();
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 1_000), true);
  })) p++; else f++;

  if (test('the paired hook 6s later is not fresh', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 7_000), false);
  })) p++; else f++;

  if (test('a notify past the dedupe window is fresh again', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    const after = 1_000 + PERMISSION_PUSH_DEDUPE_MS;
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, after), true);
  })) p++; else f++;

  if (test('the boundary itself is inside the window', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    const edge = 1_000 + PERMISSION_PUSH_DEDUPE_MS - 1;
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, edge), false);
  })) p++; else f++;

  if (test('freshness is per session, not global', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    assert.strictEqual(notifyPermission('sess-b', '', 60_000, 2_000), true);
  })) p++; else f++;

  if (test('a suppressed notify still re-arms the entry', () => {
    resetPermissions();
    notifyPermission('sess-a', 'first', 60_000, 1_000);
    notifyPermission('sess-a', 'second', 60_000, 7_000);
    assert.strictEqual(permissionWaits().get('sess-a'), 7_000);
    assert.strictEqual(permissionMessage('sess-a'), 'second');
  })) p++; else f++;

  if (test('dedupe measures from the last notify, not the first', () => {
    // Three notifies, each 6s apart. The third is 12s after the first — past
    // nothing, because the second re-armed the clock. Only the first pushes.
    resetPermissions();
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 1_000), true);
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 7_000), false);
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 13_000), false);
  })) p++; else f++;

  if (test('clearing a session makes the next notify fresh', () => {
    resetPermissions();
    notifyPermission('sess-a', '', 60_000, 1_000);
    clearPermission('sess-a');
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 2_000), true);
  })) p++; else f++;

  // --- terminal handoff: the dialog you asked for is not news ------------
  //
  // Tapping "answer in the terminal" (or the idle sweep releasing a wait, or a
  // wait timing out) hands the question to a terminal dialog. That dialog then
  // reports itself as a permission event ~10-15s later, and pushing it buzzes
  // the phone about a prompt the user just chose to walk over and answer.
  // The HID idle gate cannot catch this: the tap happened on a phone, so the
  // Mac has been idle the whole time.

  if (test('a handoff suppresses the permission push that follows', () => {
    resetPermissions();
    noteTerminalHandoff('sess-a', 1_000);
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 13_000), false);
  })) p++; else f++;

  if (test('a suppressed handoff push still shows the pill', () => {
    resetPermissions();
    noteTerminalHandoff('sess-a', 1_000);
    notifyPermission('sess-a', 'needs Bash', 60_000, 13_000);
    assert.strictEqual(permissionWaits().get('sess-a'), 13_000);
    assert.strictEqual(permissionMessage('sess-a'), 'needs Bash');
  })) p++; else f++;

  if (test('past the handoff window a dialog pushes again', () => {
    resetPermissions();
    noteTerminalHandoff('sess-a', 1_000);
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 1_000 + TERMINAL_HANDOFF_MS), true);
  })) p++; else f++;

  if (test('the handoff boundary itself is still inside the window', () => {
    resetPermissions();
    noteTerminalHandoff('sess-a', 1_000);
    assert.strictEqual(notifyPermission('sess-a', '', 60_000, 1_000 + TERMINAL_HANDOFF_MS - 1), false);
  })) p++; else f++;

  if (test('a handoff is per session', () => {
    resetPermissions();
    noteTerminalHandoff('sess-a', 1_000);
    assert.strictEqual(notifyPermission('sess-b', '', 60_000, 5_000), true);
  })) p++; else f++;

  if (test('handedToTerminal reports the window directly', () => {
    resetPermissions();
    assert.strictEqual(handedToTerminal('sess-a', 5_000), false);
    noteTerminalHandoff('sess-a', 1_000);
    assert.strictEqual(handedToTerminal('sess-a', 5_000), true);
    assert.strictEqual(handedToTerminal('sess-a', 1_000 + TERMINAL_HANDOFF_MS), false);
  })) p++; else f++;

  if (test('a later handoff re-arms the window', () => {
    resetPermissions();
    noteTerminalHandoff('sess-a', 1_000);
    noteTerminalHandoff('sess-a', 20_000);
    assert.strictEqual(handedToTerminal('sess-a', 40_000), true);
  })) p++; else f++;

  if (test('resetPermissions clears handoffs too', () => {
    noteTerminalHandoff('sess-a', 1_000);
    resetPermissions();
    assert.strictEqual(handedToTerminal('sess-a', 2_000), false);
  })) p++; else f++;

  if (test('resetPermissions clears entries (and their timers)', () => {
    notifyPermission('sess-a', '', 60_000, 1_000);
    resetPermissions();
    assert.strictEqual(permissionWaits().size, 0);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
