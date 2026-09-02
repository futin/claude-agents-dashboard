import assert from 'node:assert';

import {
  parseLedgerLine,
  rawTokens,
  serializeLedgerLine,
  sumWindow,
  TYPE_WEIGHTS,
  weightedTokens
} from '../server/lib/usage-ledger.js';
import type { LedgerLine, TokenCounts, UsageEvent } from '../server/lib/usage-ledger.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const tc = (i: number, o: number, cc: number, cr: number): TokenCounts =>
  ({ in: i, out: o, cc, cr });

const ev = (ts: number, model: string, tok: TokenCounts): UsageEvent => ({ ts, model, tok });

export function run(): number {
  console.log('\n=== usage-ledger.ts (pure core) ===\n');
  let p = 0, f = 0;

  // ── weighting ──

  if (test('weightedTokens: the ratio set, on a mixed count', () => {
    // 1000·1 + 100·5 + 200·1.25 + 10000·0.1
    assert.strictEqual(weightedTokens(tc(1000, 100, 200, 10_000)), 2750);
  })) p++; else f++;

  if (test('weightedTokens: all zero → 0', () => {
    assert.strictEqual(weightedTokens(tc(0, 0, 0, 0)), 0);
  })) p++; else f++;

  if (test('rawTokens: the same counts, unweighted', () => {
    assert.strictEqual(rawTokens(tc(1000, 100, 200, 10_000)), 11_300);
  })) p++; else f++;

  if (test('the ratios are the documented ones', () => {
    assert.deepStrictEqual(TYPE_WEIGHTS, { in: 1, out: 5, cc: 1.25, cr: 0.1 });
  })) p++; else f++;

  // ── sumWindow: the half-open (prevT, t] boundary ──

  if (test('sumWindow: (prevT, t] excludes prevT, includes t — for counts too', () => {
    const events = [
      ev(1000, 'A', tc(1, 0, 0, 0)),     // == prevT → out
      ev(1001, 'A', tc(0, 2, 0, 0)),     // just inside → in
      ev(61_000, 'A', tc(0, 0, 4, 0)),   // == t → in
      ev(61_001, 'A', tc(0, 0, 0, 8))    // just past → out
    ];
    assert.deepStrictEqual(sumWindow(events, 1000, 61_000), {
      tok: { A: tc(0, 2, 4, 0) },
      req: { A: 2 }
    });
  })) p++; else f++;

  if (test('sumWindow: groups by model, sums each type, counts one per event', () => {
    const events = [
      ev(10, 'opus-5', tc(1, 2, 3, 4)),
      ev(20, 'opus-5', tc(10, 20, 30, 40)),
      ev(30, 'fable-5', tc(5, 5, 5, 5))
    ];
    assert.deepStrictEqual(sumWindow(events, 0, 100), {
      tok: {
        'opus-5': tc(11, 22, 33, 44),
        'fable-5': tc(5, 5, 5, 5)
      },
      req: { 'opus-5': 2, 'fable-5': 1 }
    });
  })) p++; else f++;

  if (test('sumWindow: an empty model string is skipped, not bucketed as ""', () => {
    const events = [ev(10, '', tc(9, 9, 9, 9)), ev(20, 'A', tc(1, 1, 1, 1))];
    assert.deepStrictEqual(sumWindow(events, 0, 100), { tok: { A: tc(1, 1, 1, 1) }, req: { A: 1 } });
  })) p++; else f++;

  if (test('sumWindow: no events in range → two empty maps, a measured zero', () => {
    assert.deepStrictEqual(sumWindow([ev(5, 'A', tc(1, 1, 1, 1))], 10, 20), { tok: {}, req: {} });
  })) p++; else f++;

  // ── the line codec ──

  if (test('parse(serialize(x)) round-trips exactly', () => {
    const line: LedgerLine = {
      t: 1_700_000_060_000,
      prevT: 1_700_000_000_000,
      tok: { 'opus-5': tc(12, 34, 56, 78), 'fable-5': tc(0, 0, 0, 0) }
    };
    assert.deepStrictEqual(parseLedgerLine(serializeLedgerLine(line)), line);
  })) p++; else f++;

  if (test('request counts round-trip intact', () => {
    const line: LedgerLine = {
      t: 1_700_000_060_000,
      prevT: 1_700_000_000_000,
      tok: { 'opus-5': tc(12, 34, 56, 78), 'fable-5': tc(1, 1, 1, 1) },
      req: { 'opus-5': 7, 'fable-5': 0 }
    };
    const back = parseLedgerLine(serializeLedgerLine(line));
    assert.deepStrictEqual(back, line);
    assert.strictEqual(back!.req!['fable-5'], 0, 'a recorded zero survives as zero');
  })) p++; else f++;

  if (test('a line written before counts existed parses with req absent, not zeroed', () => {
    const old = JSON.stringify({ t: 2, prevT: 1, tok: { A: { in: 5, out: 0, cc: 0, cr: 0 } } });
    const parsed = parseLedgerLine(old);
    assert.ok(parsed);
    assert.strictEqual(parsed.req, undefined, 'absent must not coerce to {} or to 0');
    assert.ok(!('req' in parsed), 'and must not appear as a key at all');
    assert.deepStrictEqual(parsed.tok, { A: tc(5, 0, 0, 0) }, 'its tokens are still usable');
  })) p++; else f++;

  if (test('junk and negative counts drop that model only; the line stays usable', () => {
    const parsed = parseLedgerLine(JSON.stringify({
      t: 2, prevT: 1,
      tok: { A: { in: 5, out: 0, cc: 0, cr: 0 }, B: { in: 3, out: 0, cc: 0, cr: 0 }, C: { in: 1, out: 0, cc: 0, cr: 0 } },
      req: { A: 'two', B: -1, C: 4 }
    }));
    assert.ok(parsed);
    assert.strictEqual(parsed.req!.A, undefined, 'a non-numeric count is absent, never 0');
    assert.strictEqual(parsed.req!.B, undefined, 'a negative count is absent too');
    assert.strictEqual(parsed.req!.C, 4);
    assert.deepStrictEqual(parsed.tok.A, tc(5, 0, 0, 0), 'the token counts are untouched');
  })) p++; else f++;

  if (test('a non-object req is the same as no req at all', () => {
    const parsed = parseLedgerLine(JSON.stringify({ t: 2, prevT: 1, tok: {}, req: 5 }));
    assert.strictEqual(parsed!.req, undefined);
    const arr = parseLedgerLine(JSON.stringify({ t: 2, prevT: 1, tok: {}, req: [1, 2] }));
    assert.strictEqual(arr!.req, undefined, 'an array is not a map');
  })) p++; else f++;

  if (test('serialize: one line, no embedded newline', () => {
    const s = serializeLedgerLine({ t: 2, prevT: 1, tok: {} });
    assert.ok(!s.includes('\n'), 'serialized line must not contain a newline');
    assert.deepStrictEqual(JSON.parse(s), { t: 2, prevT: 1, tok: {} });
  })) p++; else f++;

  if (test('parseLedgerLine: null for junk', () => {
    assert.strictEqual(parseLedgerLine('not json'), null);
    assert.strictEqual(parseLedgerLine(JSON.stringify({ prevT: 1, tok: {} })), null);        // no t
    assert.strictEqual(parseLedgerLine(JSON.stringify({ t: 2, prevT: 1 })), null);           // no tok
    assert.strictEqual(parseLedgerLine(JSON.stringify({ t: 2, prevT: 1, tok: 5 })), null);   // tok not an object
    assert.strictEqual(parseLedgerLine(JSON.stringify({ t: 2, prevT: 1, tok: [] })), null);  // an array is not a map
  })) p++; else f++;

  if (test('parseLedgerLine: missing token types read as 0, junk types dropped', () => {
    const parsed = parseLedgerLine(JSON.stringify({ t: 2, prevT: 1, tok: { A: { in: 5 }, B: 'x' } }));
    assert.deepStrictEqual(parsed, { t: 2, prevT: 1, tok: { A: tc(5, 0, 0, 0) } });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
