import assert from 'node:assert';

import { apiErrorLabel } from '../client/src/lib/apiError.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

export function run(): number {
  console.log('\n=== apiError.ts ===\n');
  let p = 0, f = 0;
  const now = 1_700_000_000_000;
  const HOUR = 60 * 60 * 1000;

  if (test('rate_limit with a reset ahead names the local time', () => {
    const at = now + 2 * HOUR;
    assert.strictEqual(apiErrorLabel({ kind: 'rate_limit', resetsAtMs: at }, now), `usage limit · resets ${clock(at)}`);
  })) p++; else f++;

  if (test('rate_limit with no reset, or one already past, says only usage limit', () => {
    assert.strictEqual(apiErrorLabel({ kind: 'rate_limit', resetsAtMs: null }, now), 'usage limit');
    assert.strictEqual(apiErrorLabel({ kind: 'rate_limit', resetsAtMs: now - 1 }, now), 'usage limit');
    assert.strictEqual(apiErrorLabel({ kind: 'rate_limit', resetsAtMs: now }, now), 'usage limit');
  })) p++; else f++;

  if (test('rate_limit resetting a day or more away names the weekday: a clock time alone would read as today', () => {
    const at = now + 3 * 24 * HOUR;
    const day = new Date(at).toLocaleDateString('en-GB', { weekday: 'short' });
    assert.strictEqual(apiErrorLabel({ kind: 'rate_limit', resetsAtMs: at }, now), `usage limit · resets ${day} ${clock(at)}`);
    const justUnder = now + 24 * HOUR - 1;
    assert.strictEqual(apiErrorLabel({ kind: 'rate_limit', resetsAtMs: justUnder }, now), `usage limit · resets ${clock(justUnder)}`);
  })) p++; else f++;

  if (test('the other kinds: not logged in, API error, and an unknown kind named verbatim', () => {
    assert.strictEqual(apiErrorLabel({ kind: 'authentication_failed', resetsAtMs: null }, now), 'not logged in');
    assert.strictEqual(apiErrorLabel({ kind: 'server_error', resetsAtMs: null }, now), 'API error');
    assert.strictEqual(apiErrorLabel({ kind: 'invalid_request', resetsAtMs: null }, now), 'API error · invalid_request');
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
