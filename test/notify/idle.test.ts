/**
 * `parseIdleSecs` — the half of `readIdleSecs` that reads `ioreg -c IOHIDSystem` output. Every held wait and the AFK push gate decide on this number, so
 * a wrong divisor or a garbled line read as a number would release holds while the user is away (or never). The `ioreg` run itself stays untested here:
 * it is a spawn, and every store's tests swap it out through `setIdleReader`.
 */
import assert from 'node:assert';

import { parseIdleSecs } from '../../server/lib/idle.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** The shape of the real line, indented inside the IOHIDSystem node the way `ioreg` prints it. */
const line = (ns: string): string =>
  `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000465, registered, matched, active, busy 0 (0 ms), retain 23>\n` +
  `    {\n      "HIDIdleTime" = ${ns}\n      "HIDParameters" = {"HIDDefaultParameters"=Yes}\n    }\n`;

export function run(): number {
  console.log('\n=== idle.ts: parseIdleSecs ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('a real HIDIdleTime line → whole seconds (nanoseconds ÷ 1e9, floored)', () => {
    assert.strictEqual(parseIdleSecs(line('42000000000')), 42);
    assert.strictEqual(parseIdleSecs(line('1999999999')), 1, 'floored, never rounded up');
    assert.strictEqual(parseIdleSecs(line('999999999')), 0);
    assert.strictEqual(parseIdleSecs(line('0')), 0);
  }));

  r(test('missing or garbled output → null, the documented "unreadable" fallback', () => {
    assert.strictEqual(parseIdleSecs(''), null);
    assert.strictEqual(parseIdleSecs('+-o IOHIDSystem  <class IOHIDSystem>\n    {\n    }\n'), null, 'no HIDIdleTime line');
    assert.strictEqual(parseIdleSecs(line('"abc"')), null, 'a non-numeric value');
    assert.strictEqual(parseIdleSecs(line('-5')), null, 'a signed value is not a reading');
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
