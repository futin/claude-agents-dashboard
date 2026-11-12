/**
 * `afkStillGatesRemote` (client/src/lib/notifyRows.ts): when Settings warns that question/plan pushes still wait for AFK with "Only when I'm away" off.
 */
import assert from 'node:assert';

import { afkStillGatesRemote } from '../client/src/lib/notifyRows.js';
import type { NotifyPolicy } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Notify = Pick<NotifyPolicy, 'enabled' | 'requireAfk' | 'events'>;

function policy(over: { enabled?: boolean; requireAfk?: boolean; question?: boolean; plan?: boolean } = {}): Notify {
  const events = { question: over.question ?? true, plan: over.plan ?? true } as Notify['events'];
  return { enabled: over.enabled ?? true, requireAfk: over.requireAfk ?? false, events };
}

export function run(): number {
  console.log('\n=== afkStillGatesRemote (client/src/lib/notifyRows.ts) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test('the full table over its five inputs: shows exactly when configured, on, switch off, idle live and question or plan on', () => {
    for (const pushUnconfigured of [false, true])
      for (const enabled of [false, true])
        for (const requireAfk of [false, true])
          for (const question of [false, true])
            for (const plan of [false, true])
              for (const idleSecs of [0, 120]) {
                const want = !pushUnconfigured && enabled && !requireAfk && (question || plan) && idleSecs > 0;
                const got = afkStillGatesRemote({ pushUnconfigured, notify: policy({ enabled, requireAfk, question, plan }), idleSecs });
                assert.strictEqual(got, want, JSON.stringify({ pushUnconfigured, enabled, requireAfk, question, plan, idleSecs }));
              }
  }));

  tally(test('one affected event is enough: question alone, plan alone', () => {
    assert.strictEqual(afkStillGatesRemote({ pushUnconfigured: false, notify: policy({ plan: false }), idleSecs: 60 }), true);
    assert.strictEqual(afkStillGatesRemote({ pushUnconfigured: false, notify: policy({ question: false }), idleSecs: 60 }), true);
  }));

  tally(test('still loading (no notify, no idleSecs) shows nothing', () => {
    assert.strictEqual(afkStillGatesRemote({ pushUnconfigured: false, notify: undefined, idleSecs: 60 }), false);
    assert.strictEqual(afkStillGatesRemote({ pushUnconfigured: false, notify: policy(), idleSecs: undefined }), false);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
