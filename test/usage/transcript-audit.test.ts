/**
 * The `scripts/lib/transcript-audit.ts` exports behind rates-audit's `gap` and `ledger` subcommands that `rates-audit.test.ts` does not reach:
 * the file scan, the mode and off-book readers, the bin accumulator and its two table folds, and the UTC day helpers.
 *
 * Every expected number is worked by hand from the fixture beside it. `test-model` is no model the ledger knows, so it weighs at the default
 * `{ in: 1, out: 5, cc: 2, cr: 0.1 }`; `claude-fable-5-1` is the one override, a cache read at 0.025.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addBin, completeDays, DAY_MS, emptyAcc, mergeLevels, modeAt, readOffbookMarks, scanFiles, stratify, utcDay
} from '../../scripts/lib/transcript-audit.js';
import type { Acc, AuditFile, Bin, Covariates, LabelledBin } from '../../scripts/lib/transcript-audit.js';
import type { TokenCounts } from '../../server/lib/usage-ledger.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const M = 'test-model';
const tc = (i: number, o: number, cc: number, cr: number): TokenCounts => ({ in: i, out: o, cc, cr });

function bin(tok: Record<string, TokenCounts>, dUtil: number): Bin {
  return { fromT: 0, toT: 60_000, dUtil, tok, intervals: 1, fromUtil: null };
}

function acc(over: Partial<Acc>): Acc {
  return { ...emptyAcc(), ...over };
}

function cov(surface: string, mode: string): Covariates {
  return { surface, mode, concurrency: '1', nestedShare: '<25%', utilBand: '(none)', offbook: 'clean' };
}

/** Write `lines` as one transcript in a fresh tmpdir and describe it the way `walkTranscripts` would. */
function file(dir: string, name: string, lines: string[], session: string, nested = false): AuditFile {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return { file: p, nested, session, mtimeMs: 0 };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function run(): number {
  console.log('\n=== transcript-audit.ts helpers ===\n');
  let p = 0, f = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-taudit-'));

  try {
    if (test('utcDay is the UTC calendar day, whatever the local zone', () => {
      assert.strictEqual(utcDay(Date.UTC(2026, 10, 12, 0, 0, 0)), '2026-11-12');
      assert.strictEqual(utcDay(Date.UTC(2026, 10, 12, 23, 59, 59, 999)), '2026-11-12');
      assert.strictEqual(utcDay(Date.UTC(2026, 10, 13)), '2026-11-13');
    })) p++; else f++;

    if (test('completeDays ends at the start of today (UTC) and reaches back whole days', () => {
      const midnight = Date.UTC(2026, 10, 12);
      assert.deepStrictEqual(completeDays(midnight + 15.5 * 3_600_000, 3), { sinceMs: Date.UTC(2026, 10, 9), untilMs: midnight });
      // Exactly midnight: today has no complete part yet, so it is still excluded.
      assert.deepStrictEqual(completeDays(midnight, 1), { sinceMs: midnight - DAY_MS, untilMs: midnight });
      assert.deepStrictEqual(completeDays(midnight - 1, 1), { sinceMs: midnight - 2 * DAY_MS, untilMs: midnight - DAY_MS });
    })) p++; else f++;

    if (test('modeAt picks the latest mark at or before ts, undefined before the first', () => {
      const marks = [{ ts: 100, mode: 'default' }, { ts: 200, mode: 'auto' }, { ts: 300, mode: 'plan' }];
      assert.strictEqual(modeAt(undefined, 150), undefined);
      assert.strictEqual(modeAt([], 150), undefined);
      assert.strictEqual(modeAt(marks, 99), undefined);
      assert.strictEqual(modeAt(marks, 100), 'default');
      assert.strictEqual(modeAt(marks, 199), 'default');
      assert.strictEqual(modeAt(marks, 200), 'auto');
      assert.strictEqual(modeAt(marks, 299), 'auto');
      assert.strictEqual(modeAt(marks, 10_000), 'plan');
    })) p++; else f++;

    if (test('addBin adds a bin’s spend for one model at that model’s weights', () => {
      const a = emptyAcc();
      // weighted = 10·1 + 4·5 + 100·2 + 1000·0.1 = 330
      const b = bin({ [M]: tc(10, 4, 100, 1000), other: tc(999, 999, 999, 999) }, 2);
      addBin(a, b, 3, M);
      assert.deepStrictEqual(a, { bins: 1, util: 2, weighted: 330, requests: 3, cc: 100, cr: 1000, out: 4, ccW: 200, crW: 100, outW: 20 });
      addBin(a, b, 1, M);
      assert.deepStrictEqual(a, { bins: 2, util: 4, weighted: 660, requests: 4, cc: 200, cr: 2000, out: 8, ccW: 400, crW: 200, outW: 40 });

      const fable = emptyAcc();
      addBin(fable, bin({ 'claude-fable-5-1': tc(0, 0, 0, 1000) }, 1), 1, 'claude-fable-5-1');
      assert.strictEqual(fable.weighted, 25);
      assert.strictEqual(fable.crW, 25);
    })) p++; else f++;

    const A: LabelledBin = { bin: bin({ [M]: tc(0, 0, 100, 0) }, 1), cov: cov('cli', 'auto'), requests: 2 };      // weighted 200
    const B: LabelledBin = { bin: bin({ [M]: tc(0, 0, 0, 1000) }, 2), cov: cov('cli', 'default'), requests: 1 };  // weighted 100
    const C: LabelledBin = { bin: bin({ [M]: tc(0, 10, 0, 0) }, 3), cov: cov('cli', 'auto'), requests: 4 };       // weighted 50
    const D: LabelledBin = { bin: bin({ [M]: tc(7, 0, 0, 0) }, 1), cov: cov('sdk-cli', 'auto'), requests: 1 };    // weighted 7

    if (test('stratify groups bins by surface, then by the covariate’s level', () => {
      const table = stratify([A, B, C, D], 'mode', M);
      assert.deepStrictEqual(table, new Map([
        ['cli', new Map([
          ['auto', acc({ bins: 2, util: 4, weighted: 250, requests: 6, cc: 100, out: 10, ccW: 200, outW: 50 })],
          ['default', acc({ bins: 1, util: 2, weighted: 100, requests: 1, cr: 1000, crW: 100 })]
        ])],
        ['sdk-cli', new Map([['auto', acc({ bins: 1, util: 1, weighted: 7, requests: 1 })]])]
      ]));
      // Another covariate reads another field: every bin here is `concurrency` 1.
      assert.deepStrictEqual([...stratify([A, B, C], 'concurrency', M).get('cli')!.keys()], ['1']);
    })) p++; else f++;

    if (test('mergeLevels sums each level across tables into fresh rows', () => {
      const t1 = new Map([['auto', acc({ bins: 2, util: 4, weighted: 250, requests: 6 })], ['default', acc({ bins: 1, util: 2, weighted: 100 })]]);
      const t2 = new Map([['auto', acc({ bins: 1, util: 1, weighted: 7, requests: 1, cc: 5 })]]);
      const merged = mergeLevels([t1, t2]);
      assert.deepStrictEqual(merged, new Map([
        ['auto', acc({ bins: 3, util: 5, weighted: 257, requests: 7, cc: 5 })],
        ['default', acc({ bins: 1, util: 2, weighted: 100 })]
      ]));
      // The inputs are left alone: a level only one table has is copied, not shared.
      assert.notStrictEqual(merged.get('default'), t1.get('default'));
      assert.deepStrictEqual(t1.get('auto'), acc({ bins: 2, util: 4, weighted: 250, requests: 6 }));
      assert.deepStrictEqual(mergeLevels([]), new Map());
    })) p++; else f++;

    if (test('readOffbookMarks collects each session’s unpriced assistant lines, sorted', () => {
      const t = (s: number): number => Date.UTC(2026, 10, 12, 10, 0, s);
      const usage = { input_tokens: 1, output_tokens: 1 };
      const top = file(tmp, 'sA.jsonl', [
        JSON.stringify({ timestamp: iso(t(5)), message: { role: 'assistant', model: M, usage } }),                                // priced: not off-book
        JSON.stringify({ timestamp: iso(t(3)), isApiErrorMessage: true, message: { role: 'assistant', model: M, usage } }),   // API error, even with usage
        JSON.stringify({ timestamp: iso(t(1)), message: { role: 'assistant', model: M } }),                                     // no usage
        JSON.stringify({ timestamp: iso(t(2)), message: { role: 'user', content: 'hi' } }),                                     // not assistant
        JSON.stringify({ timestamp: 'not a time', message: { role: 'assistant', model: M } }),                                  // no parseable time
        'junk "assistant" line'
      ], 'sA');
      const nested = file(tmp, 'agent-1.jsonl', [
        JSON.stringify({ timestamp: iso(t(4)), message: { role: 'assistant', model: M } })
      ], 'sA', true);
      const clean = file(tmp, 'sB.jsonl', [
        JSON.stringify({ timestamp: iso(t(6)), message: { role: 'assistant', model: M, usage } })
      ], 'sB');
      // A nested file files under its parent session; a session with nothing off-book is absent rather than empty.
      assert.deepStrictEqual(readOffbookMarks([top, nested, clean]), new Map([['sA', [t(1), t(3), t(4)]]]));
    })) p++; else f++;

    if (test('scanFiles parses every object line, skips junk and unreadable files, and pre-filters', () => {
      const f1 = file(tmp, 'scan.jsonl', ['{"a":1,"k":"usage"}', 'junk', '', '"a string"', 'null', '{"b":2}'], 's1');
      const gone: AuditFile = { file: path.join(tmp, 'missing.jsonl'), nested: false, session: 's2', mtimeMs: 0 };
      const seen = (filter?: string | string[]): [Record<string, unknown>, AuditFile][] => {
        const out: [Record<string, unknown>, AuditFile][] = [];
        scanFiles([gone, f1], (raw, af) => { out.push([raw, af]); }, filter);
        return out;
      };
      assert.deepStrictEqual(seen(), [[{ a: 1, k: 'usage' }, f1], [{ b: 2 }, f1]]);
      assert.deepStrictEqual(seen('usage'), [[{ a: 1, k: 'usage' }, f1]]);
      // Several needles: a line containing any one of them passes.
      assert.deepStrictEqual(seen(['"b"', 'nowhere']), [[{ b: 2 }, f1]]);
      assert.deepStrictEqual(seen(['"a"', '"b"']).length, 2);
      assert.deepStrictEqual(seen([]), []);
    })) p++; else f++;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
