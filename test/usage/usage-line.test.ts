/** `server/lib/usage-line.ts` — the one parse of an assistant usage line. What each reader does with it is `usage-line-callers.test.ts`. */
import assert from 'node:assert';

import { assistantUsage } from '../../server/lib/usage-line.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const TS = '2026-11-14T10:00:00.000Z';
const usage = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 };
const full = (message: Record<string, unknown> = {}, rec: Record<string, unknown> = {}) =>
  ({ timestamp: TS, ...rec, message: { role: 'assistant', id: 'msg_1', model: 'claude-opus-4-8', usage, ...message } });

export function run(): number {
  console.log('\n=== usage-line.ts (assistantUsage) ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('null unless an assistant message carries an object usage', () => {
    assert.strictEqual(assistantUsage({ message: { role: 'user', usage: {} } }), null);
    assert.strictEqual(assistantUsage({ message: { role: 'assistant' } }), null);
    assert.strictEqual(assistantUsage({ message: { role: 'assistant', usage: 5 } }), null);
    assert.strictEqual(assistantUsage({ message: 'assistant' }), null);
    for (const v of [null, undefined, 3, 'x']) assert.strictEqual(assistantUsage(v), null);
  }));

  r(test('a full record: id, model, ts as Date.parse of the timestamp, the four counts and the raw usage', () => {
    const got = assistantUsage(full())!;
    assert.strictEqual(got.id, 'msg_1');
    assert.strictEqual(got.model, 'claude-opus-4-8');
    assert.strictEqual(got.ts, Date.parse(TS));
    assert.deepStrictEqual(got.tok, { in: 1, out: 2, cc: 3, cr: 4 });
    assert.strictEqual(got.usage, (full().message as { usage: object }).usage);
  }));

  r(test('a count that is not a finite number reads as 0', () => {
    for (const bad of ['7', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      assert.deepStrictEqual(assistantUsage(full({ usage: { ...usage, input_tokens: bad } }))!.tok, { in: 0, out: 2, cc: 3, cr: 4 }, String(bad));
    }
  }));

  r(test('an empty-string or missing id is null; a missing model is empty; a missing or non-string timestamp is NaN', () => {
    assert.strictEqual(assistantUsage(full({ id: '' }))!.id, null);
    assert.strictEqual(assistantUsage(full({ id: undefined }))!.id, null);
    assert.strictEqual(assistantUsage(full({ model: undefined }))!.model, '');
    assert.strictEqual(assistantUsage(full({ model: 42 }))!.model, '');
    assert.ok(Number.isNaN(assistantUsage(full({}, { timestamp: undefined }))!.ts));
    assert.ok(Number.isNaN(assistantUsage(full({}, { timestamp: 1_700_000_000_000 }))!.ts));
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
