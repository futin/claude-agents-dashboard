import assert from 'node:assert';

import type { UsageCoverage } from '../shared/types.js';
import {
  baselineText,
  coverageClauses,
  evidenceText,
  fittedAsideText,
  formatDeviation,
  formatShareOf,
  formatSharePct,
  formatTok,
  pricedPillText,
  rawAsideText,
  verdictText
} from '../client/src/lib/usageRatesFormat.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== usageRatesFormat.ts ===\n');
  let p = 0, f = 0;

  if (test('formatTok: the five documented magnitudes', () => {
    assert.strictEqual(formatTok(210_000), '210k');
    assert.strictEqual(formatTok(1_500_000), '1.5M');
    assert.strictEqual(formatTok(2_000_000), '2.0M');
    assert.strictEqual(formatTok(950), '950');
    assert.strictEqual(formatTok(null), '—');
  })) p++; else f++;

  if (test('formatTok: an unfitted rate is a dash, never a zero', () => {
    assert.strictEqual(formatTok(Number.NaN), '—');
    assert.strictEqual(formatTok(0), '0');
    assert.strictEqual(formatTok(999), '999');
    assert.strictEqual(formatTok(1_000), '1k');
  })) p++; else f++;

  if (test('formatDeviation always carries its sign', () => {
    assert.strictEqual(formatDeviation(66.6667), '+66.7%');
    assert.strictEqual(formatDeviation(-30), '-30.0%');
    assert.strictEqual(formatDeviation(0), '+0.0%');
    assert.strictEqual(formatDeviation(null), '—');
  })) p++; else f++;

  if (test('evidenceText states windows, days and cumulative movement', () => {
    assert.strictEqual(evidenceText(10, 2, 5), '10 windows · 2 days · 5.0 pts');
    assert.strictEqual(evidenceText(1, 1, 0.25), '1 window · 1 day · 0.3 pts');
    assert.strictEqual(evidenceText(428, 4, 455), '428 windows · 4 days · 455.0 pts');
  })) p++; else f++;

  if (test('baselineText tells a forming baseline apart from an absent one', () => {
    // The disclosure half of bug-17: with every baseline rate null, "no
    // baseline yet" and "one startup day, refused" read identically on screen.
    assert.strictEqual(baselineText(null, 0), 'no baseline yet');
    assert.strictEqual(baselineText(null, 1), 'baseline forming · 1 day');
    assert.strictEqual(baselineText(null, 6), 'baseline forming · 6 days');
    assert.strictEqual(baselineText(163_184, 9), 'baseline 163k · 9 days');
  })) p++; else f++;

  if (test('baselineText: a rate with no days behind it is still no baseline', () => {
    // Unreachable from the server — a fitted rate always has days — but the
    // day count is what the copy claims, so it is what decides the wording.
    assert.strictEqual(baselineText(900_000, 0), 'no baseline yet');
    assert.strictEqual(baselineText(Number.NaN, 3), 'baseline forming · 3 days');
  })) p++; else f++;

  if (test('every verdict has copy, and thin reads as collecting', () => {
    assert.strictEqual(verdictText('drift').label, 'drift');
    assert.strictEqual(verdictText('stable').label, 'stable');
    assert.strictEqual(verdictText('mix-shift').label, 'mix shift');
    assert.strictEqual(verdictText('thin').label, 'collecting');
    for (const v of ['drift', 'stable', 'mix-shift', 'thin'] as const) {
      assert.ok(verdictText(v).hint.length > 0, `${v} needs a hint`);
    }
    // The thin hint names both day floors, so the card says what it is waiting
    // for rather than only that it is waiting.
    assert.match(verdictText('thin').hint, /7 separate days/);
    assert.match(verdictText('thin').hint, /2 behind the current window/);
  })) p++; else f++;

  if (test('rawAsideText labels the raw figure as a mix-dependent translation', () => {
    assert.strictEqual(
      rawAsideText(1_737_000),
      "\u2248 1.7M raw at this model's recent mix"
    );
    assert.strictEqual(
      rawAsideText(358_000),
      "\u2248 358k raw at this model's recent mix"
    );
  })) p++; else f++;

  if (test('rawAsideText: a translation of nothing is no line, never a dash', () => {
    assert.strictEqual(rawAsideText(null), null);
    assert.strictEqual(rawAsideText(Number.NaN), null);
  })) p++; else f++;

  if (test('fittedAsideText names the fitted rate and where it was measured', () => {
    assert.strictEqual(
      fittedAsideText(357_000, null),
      'fitted 357k weighted / 1% across mixed-model windows'
    );
    assert.strictEqual(
      fittedAsideText(357_000, 58.3),
      'fitted 357k weighted / 1% across mixed-model windows · +58.3% vs the rate above'
    );
    // Magnitudes come from `formatTok`, so one value in each of its bands.
    assert.strictEqual(
      fittedAsideText(1_513_000, -12),
      'fitted 1.5M weighted / 1% across mixed-model windows · -12.0% vs the rate above'
    );
    assert.strictEqual(
      fittedAsideText(840, null),
      'fitted 840 weighted / 1% across mixed-model windows'
    );
  })) p++; else f++;

  if (test('fittedAsideText: no fitted rate is no line, never a dash', () => {
    assert.strictEqual(fittedAsideText(null, null), null);
    assert.strictEqual(fittedAsideText(null, 58.3), null, 'a deviation without a rate is still no line');
    assert.strictEqual(fittedAsideText(Number.NaN, null), null);
  })) p++; else f++;

  if (test('fittedAsideText owns no threshold: a huge gap renders like a small one', () => {
    // The threshold is the server's, and there is no verdict to make here —
    // asserting that both render identically is what pins that.
    const small = fittedAsideText(210_000, 0.4)!;
    const huge = fittedAsideText(210_000, 1064.2)!;
    assert.strictEqual(small.replace('+0.4%', 'X'), huge.replace('+1064.2%', 'X'));
    assert.ok(huge.endsWith('· +1064.2% vs the rate above'), huge);
  })) p++; else f++;

  if (test('formatSharePct rounds, and null stays null', () => {
    assert.strictEqual(formatSharePct(12.4), '12%');
    assert.strictEqual(formatSharePct(0), '0%');
    assert.strictEqual(formatSharePct(null), null);
  })) p++; else f++;

  // ── the coverage footer ──

  /** Every counter zeroed and the start provable — each case moves what it needs. */
  const cov = (over: Partial<UsageCoverage> = {}): UsageCoverage => ({
    movedPct: 100, pricedPct: 0, mixedPct: 0, externalPct: 0,
    preLedgerPct: 0, missingPct: 0, partialPct: 0,
    recorderBreakHours: 0, startProvable: true, ...over
  });

  if (test('formatShareOf keeps a decimal under 1%, so a real bucket never reads as 0%', () => {
    assert.strictEqual(formatShareOf(41.8, 100), '42%');
    assert.strictEqual(formatShareOf(0.2, 100), '0.2%');
    assert.strictEqual(formatShareOf(0, 100), '0%');
    assert.strictEqual(formatShareOf(5, 0), '0%', 'a share of nothing is not a division');
  })) p++; else f++;

  if (test('a bucket that cost nothing produces no clause at all', () => {
    const clauses = coverageClauses(cov({ pricedPct: 100 })).join(' | ');
    assert.ok(!clauses.includes('predates'), clauses);
    assert.ok(!clauses.includes('part-covered'), clauses);
    assert.ok(!clauses.includes('recorder down'), clauses);
    assert.ok(!clauses.includes('90%'), clauses);
    assert.strictEqual(clauses, '', 'nothing was refused, so the row says nothing');
  })) p++; else f++;

  if (test('nothing moved → no pill and no clauses, rather than a row of zeroes', () => {
    assert.strictEqual(pricedPillText(cov({ movedPct: 0 })), null);
    assert.deepStrictEqual(coverageClauses(cov({ movedPct: 0 })), []);
  })) p++; else f++;

  if (test('an unprovable start replaces the pre-ledger clause with the rotation caveat', () => {
    const clauses = coverageClauses(cov({
      pricedPct: 58, missingPct: 42, recorderBreakHours: 3, startProvable: false
    }));
    assert.ok(clauses[0].includes('rotated'), clauses.join(' | '));
    assert.ok(!clauses.join(' | ').includes('predates recording'),
      'nothing may be claimed as pre-ledger when the start is unknown');
  })) p++; else f++;

  if (test('the recorder-down clause names the hours and the points together', () => {
    // 12.4 h beside no number reads as 12.4 h of lost spend, which is exactly
    // the misreading this footer exists to prevent.
    // 12.35 prints as 12.3: `toFixed(1)` rounds the binary double, which sits
    // a hair below 12.35. Pinned as it actually renders rather than as decimal
    // arithmetic would like it to.
    const [clause] = coverageClauses(cov({ pricedPct: 98, missingPct: 2, recorderBreakHours: 12.35 }));
    assert.ok(clause.includes('12.3 h'), clause);
    assert.ok(clause.includes('2%'), clause);
  })) p++; else f++;

  if (test('the live shape from 2026-09-02 reads as a sentence, largest refusal first', () => {
    const live = cov({
      movedPct: 1048, pricedPct: 418, preLedgerPct: 438, missingPct: 2,
      partialPct: 32, recorderBreakHours: 12.35
    });
    assert.strictEqual(pricedPillText(live), '40% priced');
    const clauses = coverageClauses(live);
    assert.strictEqual(clauses.length, 3, clauses.join(' | '));
    assert.strictEqual(clauses[0], '42% predates recording — ages out on its own');
    assert.ok(clauses[1].startsWith('3% from windows'), clauses[1]);
    assert.strictEqual(clauses[2], 'recorder down 12.3 h — cost 0.2% of what moved');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
