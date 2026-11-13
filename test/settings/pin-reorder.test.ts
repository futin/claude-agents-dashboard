/**
 * `settleReorder` (client/src/lib/pinWrite.ts): what `usePins`'s reorder leaves on screen once the write answers — above all the 409, which re-reads the list
 * and rolls back to the pre-drag rows only when that read fails.
 */
import assert from 'node:assert';

import { NETWORK_TEXT, RELOADED_TEXT, settleReorder, type PinsReader } from '../../client/src/lib/pinWrite.js';
import type { PinsResponse } from '../../shared/types.js';

async function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const pins = (home: string): PinsResponse => ({ pinned: [], recent: [], older: [], home });
const BEFORE = pins('before');
const SERVER = pins('server');

/** A reader that answers `body` with `ok`, counting its calls. */
function reader(ok: boolean, body: unknown): PinsReader & { calls: number } {
  const r = Object.assign(async () => { r.calls++; return { ok, json: async () => body }; }, { calls: 0 });
  return r;
}

const conflict = { kind: 'conflict', text: 'Conflict.' } as const;

export async function run(): Promise<number> {
  console.log('\n=== settleReorder (client/src/lib/pinWrite.ts) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(await test('409: re-reads the list and shows the server\'s rows with the reloaded note', async () => {
    const read = reader(true, SERVER);
    assert.deepStrictEqual(await settleReorder(conflict, BEFORE, read), { pins: SERVER, text: RELOADED_TEXT });
    assert.strictEqual(read.calls, 1);
  }));
  tally(await test('409 and the re-read is not ok: rolls back to the pre-drag rows with the network note', async () => {
    assert.deepStrictEqual(await settleReorder(conflict, BEFORE, reader(false, SERVER)), { pins: BEFORE, text: NETWORK_TEXT });
  }));
  tally(await test('409 and the re-read throws, or answers without a pin list: rolls back', async () => {
    const throws: PinsReader = async () => { throw new Error('offline'); };
    assert.deepStrictEqual(await settleReorder(conflict, BEFORE, throws), { pins: BEFORE, text: NETWORK_TEXT });
    assert.deepStrictEqual(await settleReorder(conflict, BEFORE, reader(true, { error: 'x' })), { pins: BEFORE, text: NETWORK_TEXT });
    assert.deepStrictEqual(await settleReorder(conflict, null, reader(true, null)), { pins: null, text: NETWORK_TEXT });
  }));
  tally(await test('fresh: the reply\'s rows, no note, no re-read', async () => {
    const read = reader(true, SERVER);
    assert.deepStrictEqual(await settleReorder({ kind: 'fresh', pins: SERVER }, BEFORE, read), { pins: SERVER, text: null });
    assert.strictEqual(read.calls, 0);
  }));
  tally(await test('saved: the optimistic rows stay (no pins key), the note shows', async () => {
    const out = await settleReorder({ kind: 'saved', text: 'Saved, but…' }, BEFORE, reader(true, SERVER));
    assert.deepStrictEqual(out, { text: 'Saved, but…' });
    assert.ok(!('pins' in out));
  }));
  tally(await test('failed: rolls back with the failure text, no re-read', async () => {
    const read = reader(true, SERVER);
    assert.deepStrictEqual(await settleReorder({ kind: 'failed', text: 'Nope.' }, BEFORE, read), { pins: BEFORE, text: 'Nope.' });
    assert.strictEqual(read.calls, 0);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
