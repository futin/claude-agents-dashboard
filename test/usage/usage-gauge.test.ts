/** The account chip's gauge rules (`client/src/lib/usageGauge.ts`), out of `HeaderAccount.tsx` so a flipped threshold fails here. */
import assert from 'node:assert';

import type { RateLimit, UsageLimits } from '../../shared/types.js';
import { clampPct, gaugeLevel, outState, usageBars } from '../../client/src/lib/usageGauge.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const rl = (utilization: number | null): RateLimit => ({ utilization, resetsAt: null } as unknown as RateLimit);
const limits = (five: number | null, week: number | null): UsageLimits => ({ fiveHour: rl(five), sevenDay: rl(week) } as unknown as UsageLimits);

export function run(): number {
  console.log('\n=== usageGauge.ts ===\n');
  let p = 0, f = 0;

  if (test('clampPct rounds, then holds to 0–100', () => {
    assert.strictEqual(clampPct(-5), 0);
    assert.strictEqual(clampPct(59.5), 60);
    assert.strictEqual(clampPct(140), 100);
  })) p++; else f++;

  if (test('gaugeLevel: mid from 60, high from 90', () => {
    assert.strictEqual(gaugeLevel(59), '');
    assert.strictEqual(gaugeLevel(60), 'mid');
    assert.strictEqual(gaugeLevel(89), 'mid');
    assert.strictEqual(gaugeLevel(90), 'high');
    assert.strictEqual(gaugeLevel(100), 'high');
  })) p++; else f++;

  if (test('usageBars: null is none; a null reading is dropped; zero is kept; 5h before Week', () => {
    assert.deepStrictEqual(usageBars(null), []);
    const one = usageBars(limits(40, null));
    assert.strictEqual(one.length, 1);
    assert.strictEqual(one[0].label, '5h');
    assert.strictEqual(one[0].short, '5H');
    assert.deepStrictEqual(usageBars(limits(40, 10)).map(b => b.label), ['5h', 'Week']);
    assert.deepStrictEqual(usageBars(limits(0, 0)).map(b => b.label), ['5h', 'Week']);
  })) p++; else f++;

  if (test('outState: signed-out names the command, token-expired has none, the rest are null', () => {
    assert.strictEqual(outState('signed-out')?.command, 'claude auth login');
    assert.strictEqual(outState('token-expired')?.command, null);
    assert.strictEqual(outState('token-expired')?.chip, 'Token expired');
    assert.strictEqual(outState('ok'), null);
    assert.strictEqual(outState(undefined), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
