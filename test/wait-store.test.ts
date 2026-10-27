/**
 * `wait-store.ts` on its own: the settle/supersede/cancel machine the three remote-answer stores share, and the one idle reaper across all of them. The
 * idle source is swapped with `setIdleReader`, so nothing here spawns `ioreg`; the reaper's tick is driven through `reapIdle`, never by waiting 5 s.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setIdleReader } from '../server/lib/idle.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';
import { createWaitStore, reapIdle, type WaitEntry } from '../server/lib/wait-store.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** `backAtDesk` reads `idleSecs` from the cwd's settings file, so each idle case runs in a tmpdir with a known threshold. */
function atDeskWith(idle: () => number | null, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wait-store-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    resetSettings();
    setSettings({ idleSecs: 60 });
    setIdleReader(idle);
    fn();
  } finally {
    setIdleReader(null);
    process.chdir(prev);
    resetSettings();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Result = { status: string };
interface Entry extends WaitEntry<Result> { id: string; headless?: boolean }

const settles: [string, string][] = [];
const qs = createWaitStore<Entry, Result>({
  superseded: { status: 'superseded' },
  released: { status: 'released' },
  onSettle: (entry, result) => { settles.push([entry.id, result.status]); }
});
const ms = createWaitStore<Entry, Result>({
  superseded: { status: 'superseded' },
  released: { status: 'released' },
  releasable: entry => !entry.headless
});

/** An entry with a collector standing in for the hook's held response, its timer settling it as `timeout` after `timeoutMs`. */
function entry(store: typeof qs, sessionId: string, id: string, timeoutMs = 60_000, headless = false): { e: Entry; results: Result[] } {
  const results: Result[] = [];
  const e: Entry = { sessionId, id, headless, resolve: r => { results.push(r); }, timer: setTimeout(() => store.settle(e, { status: 'timeout' }), timeoutMs) };
  return { e, results };
}

function reset(): void { qs.reset(); ms.reset(); settles.length = 0; }

export async function run(): Promise<number> {
  console.log('\n=== wait-store.ts ===\n');
  let p = 0, f = 0;

  if (test('a second entry for the same session settles the first as superseded exactly once, and only the second is held', () => {
    reset();
    const a = entry(qs, 's1', 'a'), b = entry(qs, 's1', 'b');
    qs.add(a.e);
    qs.add(b.e);
    assert.deepStrictEqual(a.results, [{ status: 'superseded' }]);
    assert.deepStrictEqual(b.results, []);
    assert.strictEqual(qs.size, 1);
    assert.strictEqual(qs.get('s1'), b.e);
    reset();
  })) p++; else f++;

  if (test('cancel with a stale id leaves the newer entry in place and resolves nothing', () => {
    reset();
    const a = entry(qs, 's1', 'a'), b = entry(qs, 's1', 'b');
    qs.add(a.e);
    qs.add(b.e);
    qs.cancel('s1', e => e.id === 'a');
    assert.strictEqual(qs.get('s1'), b.e);
    assert.deepStrictEqual(b.results, []);
    qs.cancel('s1', e => e.id === 'b');
    assert.strictEqual(qs.get('s1'), undefined);
    assert.deepStrictEqual(b.results, [], 'cancel never resolves');
    reset();
  })) p++; else f++;

  if (await testAsync('a timeout settles once; a later settle of the same entry does not resolve again', async () => {
    reset();
    const a = entry(qs, 's1', 'a', 5);
    qs.add(a.e);
    await new Promise(r => setTimeout(r, 30));
    assert.deepStrictEqual(a.results, [{ status: 'timeout' }]);
    assert.strictEqual(qs.size, 0);
    qs.settle(a.e, { status: 'answered' });
    assert.deepStrictEqual(a.results, [{ status: 'timeout' }]);
    reset();
  })) p++; else f++;

  if (test('sweepIdle at the desk releases every releasable entry and returns their count; a headless one stays', () => {
    atDeskWith(() => 3, () => {
      reset();
      const t = entry(ms, 's1', 't'), h = entry(ms, 's2', 'h', 60_000, true);
      ms.add(t.e);
      ms.add(h.e);
      assert.strictEqual(ms.sweepIdle(), 1);
      assert.deepStrictEqual(t.results, [{ status: 'released' }]);
      assert.deepStrictEqual(h.results, []);
      assert.strictEqual(ms.get('s2'), h.e);
      reset();
    });
  })) p++; else f++;

  if (test('sweepIdle with nothing releasable never reads idle', () => {
    let reads = 0;
    atDeskWith(() => { reads++; return 3; }, () => {
      reset();
      assert.strictEqual(ms.sweepIdle(), 0, 'empty store');
      ms.add(entry(ms, 's1', 'h', 60_000, true).e);
      assert.strictEqual(ms.sweepIdle(), 0, 'headless only');
      assert.strictEqual(reapIdle(), 0, 'the shared tick, headless only');
      reset();
    });
    assert.strictEqual(reads, 0);
  })) p++; else f++;

  if (test('one shared reaper tick reads idle exactly once and releases the releasable entries of both stores', () => {
    let reads = 0;
    atDeskWith(() => { reads++; return 3; }, () => {
      reset();
      const q = entry(qs, 's1', 'q'), m = entry(ms, 's2', 'm'), h = entry(ms, 's3', 'h', 60_000, true);
      qs.add(q.e);
      ms.add(m.e);
      ms.add(h.e);
      assert.strictEqual(reapIdle(), 2);
      assert.strictEqual(reads, 1);
      assert.deepStrictEqual(q.results, [{ status: 'released' }]);
      assert.deepStrictEqual(m.results, [{ status: 'released' }]);
      assert.deepStrictEqual(h.results, []);
      reset();
    });
  })) p++; else f++;

  if (test('the shared reaper tick releases nothing while the user is away', () => {
    atDeskWith(() => 9999, () => {
      reset();
      const q = entry(qs, 's1', 'q');
      qs.add(q.e);
      assert.strictEqual(reapIdle(), 0);
      assert.deepStrictEqual(q.results, []);
      reset();
    });
  })) p++; else f++;

  if (await testAsync('onSettle runs for answer, timeout, superseded, released and dismissed — and not for cancel', async () => {
    reset();
    const answered = entry(qs, 'a', 'answered');
    qs.add(answered.e);
    qs.settle(answered.e, { status: 'answered' });
    const timedOut = entry(qs, 't', 'timeout', 5);
    qs.add(timedOut.e);
    await new Promise(r => setTimeout(r, 30));
    const superseded = entry(qs, 's', 'superseded');
    qs.add(superseded.e);
    qs.add(entry(qs, 's', 'newer').e);
    const dismissed = entry(qs, 'd', 'dismissed');
    qs.add(dismissed.e);
    qs.settle(dismissed.e, { status: 'dismissed' });
    const cancelled = entry(qs, 'c', 'cancelled');
    qs.add(cancelled.e);
    qs.cancel('c', () => true);
    atDeskWith(() => 3, () => {
      qs.cancel('s', () => true); // leave only the releasable one we mean
      const released = entry(qs, 'r', 'released');
      qs.add(released.e);
      assert.strictEqual(qs.sweepIdle(), 1);
    });
    assert.deepStrictEqual(settles, [
      ['answered', 'answered'], ['timeout', 'timeout'], ['superseded', 'superseded'], ['dismissed', 'dismissed'], ['released', 'released']
    ]);
    reset();
  })) p++; else f++;

  if (test('values() is a snapshot: settling while iterating reaches every entry', () => {
    reset();
    const all = ['s1', 's2', 's3'].map(s => entry(qs, s, s));
    for (const a of all) qs.add(a.e);
    for (const e of qs.values()) qs.settle(e, { status: 'dismissed' });
    assert.deepStrictEqual(all.map(a => a.results), [[{ status: 'dismissed' }], [{ status: 'dismissed' }], [{ status: 'dismissed' }]]);
    assert.strictEqual(qs.size, 0);
    reset();
  })) p++; else f++;

  if (test('sessionIds() is a fresh Set each call', () => {
    reset();
    qs.add(entry(qs, 's1', 'a').e);
    const ids = qs.sessionIds();
    ids.add('intruder');
    assert.deepStrictEqual([...qs.sessionIds()], ['s1']);
    reset();
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
