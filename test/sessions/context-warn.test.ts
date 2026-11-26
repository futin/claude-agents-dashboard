/** The context warning threshold (`client/src/lib/contextWarn.ts`), shared by the session views and the chat drawer. */
import assert from 'node:assert';

import type { Session } from '../../shared/types.js';
import { ctxWarn } from '../../client/src/lib/contextWarn.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== contextWarn.ts ===\n');
  let p = 0, f = 0;

  if (test('amber from 70%, not below; a missing figure reads as 0', () => {
    assert.strictEqual(ctxWarn({ contextPct: 69 }), false);
    assert.strictEqual(ctxWarn({ contextPct: 70 }), true);
    assert.strictEqual(ctxWarn({ contextPct: 100 }), true);
    assert.strictEqual(ctxWarn({ contextPct: undefined } as unknown as Pick<Session, 'contextPct'>), false);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
