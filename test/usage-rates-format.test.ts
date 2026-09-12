import assert from 'node:assert';

import type { ModelRateRow, ModelRateVerdict, UsageCoverage } from '../shared/types.js';
import {
  baselineText,
  coverageCaveat,
  coverageRows,
  evidenceParts,
  evidenceText,
  figureTip,
  formatDeviation,
  formatShareOf,
  formatTok,
  hasFigures,
  measuredShare,
  movedLabel,
  movedTotal,
  ledgerReading,
  spanText,
  pricedShare,
  RATES_GLOSSARY,
  ratesStats,
  formatShare,
  verdictClass,
  statusLine,
  verdictText,
  waitingText,
  weeklyAsideText
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

  if (test('weeklyAsideText: one line, naming the week, each estimator labelled', () => {
    // A weekly rate is ~8–14× a 5-hour one, so a line that did not say which
    // window it priced would read as a tenfold drift in the tiles above it.
    assert.strictEqual(
      weeklyAsideText(2_000_000, null),
      'weekly limit: pooled 2.0M weighted / 1%'
    );
    assert.strictEqual(
      weeklyAsideText(null, 2_400_000),
      'weekly limit: fitted 2.4M weighted / 1%'
    );
    assert.strictEqual(
      weeklyAsideText(2_000_000, 2_400_000),
      'weekly limit: pooled 2.0M · fitted 2.4M weighted / 1%'
    );
  })) p++; else f++;

  if (test('weeklyAsideText: no weekly rate is no line, never a dash', () => {
    assert.strictEqual(weeklyAsideText(null, null), null);
    assert.strictEqual(weeklyAsideText(Number.NaN, Number.NaN), null);
    assert.strictEqual(weeklyAsideText(Number.NaN, 2_400_000),
      'weekly limit: fitted 2.4M weighted / 1%');
  })) p++; else f++;

  if (test('weeklyAsideText makes no comparison to the 5-hour rate', () => {
    // The two are different quantities and the two clean measurements of the
    // ratio between them disagree by 57%, so a conversion factor would be a
    // claim the data does not carry.
    const line = weeklyAsideText(2_000_000, 2_400_000)!;
    assert.ok(!line.includes('vs'), line);
    assert.ok(!line.includes('%,') && !line.includes('+') && !line.includes('×'), line);
  })) p++; else f++;

  // ── the status strip, the rows and the fold line ──

  /**
   * The live 2026-09-06 opus row, every other field zeroed. Each case moves
   * only what it is about.
   */
  const rowOf = (over: Partial<ModelRateRow> = {}): ModelRateRow => ({
    model: 'claude-opus-5',
    rawPerPct: 1_332_086,
    weightedPerPct: 220_077,
    baselineRawPerPct: null,
    baselineWeightedPerPct: null,
    deviationPct: null,
    verdict: 'thin',
    intervals: 585,
    utilSum: 663,
    days: 4,
    baselineDays: 4,
    pctPerMWeighted: null,
    pctPerRequest: null,
    splitVerdict: 'thin',
    fittedWeightedPerPct: 332_070,
    fitVerdict: 'fitted',
    fitDeviationPct: 50.888,
    weekly: {
      weightedPerPct: null, rawPerPct: null, fittedWeightedPerPct: null,
      verdict: 'thin', fitVerdict: 'thin', intervals: 0, utilSum: 0, days: 0
    },
    ...over
  });
  const verdicts = (...vs: ModelRateVerdict[]): ModelRateRow[] =>
    vs.map((verdict, i) => rowOf({ verdict, model: `m${i}` }));

  if (test('statusLine: no models is no claim at all, not "none drifting"', () => {
    assert.strictEqual(statusLine([]), null);
  })) p++; else f++;

  if (test('statusLine: five collecting models are not drifting', () => {
    const s = statusLine(verdicts('thin', 'thin', 'thin', 'thin', 'thin'))!;
    assert.strictEqual(s.headline, 'No model is drifting');
    assert.deepStrictEqual(s.counts, [{ label: 'collecting', n: 5 }]);
  })) p++; else f++;

  if (test('statusLine counts every verdict in a fixed order, zeroes omitted', () => {
    const s = statusLine(verdicts('drift', 'stable', 'thin'))!;
    assert.strictEqual(s.headline, '1 model is drifting');
    assert.deepStrictEqual(s.counts, [
      { label: 'drift', n: 1 }, { label: 'stable', n: 1 }, { label: 'collecting', n: 1 }
    ]);
  })) p++; else f++;

  if (test('statusLine agrees with itself in the plural', () => {
    assert.strictEqual(statusLine(verdicts('drift', 'drift'))!.headline, '2 models are drifting');
  })) p++; else f++;

  if (test('statusLine: a mix shift is not drift and never enters the headline', () => {
    // The opposite claim, in fact: the mix moved and the price did not.
    const s = statusLine(verdicts('mix-shift', 'stable', 'stable'))!;
    assert.strictEqual(s.headline, 'No model is drifting');
    assert.deepStrictEqual(s.counts, [{ label: 'mix shift', n: 1 }, { label: 'stable', n: 2 }]);
  })) p++; else f++;

  if (test('hasFigures: any one rate keeps a row, all three missing folds it', () => {
    assert.strictEqual(hasFigures(rowOf({
      weightedPerPct: null, rawPerPct: null, fittedWeightedPerPct: null
    })), false);
    assert.strictEqual(hasFigures(rowOf({
      weightedPerPct: null, rawPerPct: null
    })), true, 'a fitted-only model has something to show');
    assert.strictEqual(hasFigures(rowOf({
      weightedPerPct: null, fittedWeightedPerPct: null
    })), true);
    assert.strictEqual(hasFigures(rowOf({
      weightedPerPct: Number.NaN, rawPerPct: null, fittedWeightedPerPct: null
    })), false, 'NaN is not a figure');
  })) p++; else f++;

  if (test('evidenceParts splits the line the two "4 days" collided on', () => {
    const ev = evidenceParts(rowOf());
    assert.strictEqual(ev.current, '585 windows · 4 days · 663.0 pts');
    assert.strictEqual(ev.baseline, 'forming · 4 of 7 days');
  })) p++; else f++;

  if (test('evidenceParts: no baseline days at all is "none yet"', () => {
    assert.strictEqual(evidenceParts(rowOf({ baselineDays: 0 })).baseline, 'none yet');
  })) p++; else f++;

  if (test('evidenceParts states a baseline that exists', () => {
    assert.strictEqual(
      evidenceParts(rowOf({ baselineWeightedPerPct: 163_000, baselineDays: 9 })).baseline,
      '163k · 9 days'
    );
  })) p++; else f++;

  if (test('evidenceParts stops naming the floor once the baseline is past it', () => {
    // Still forming at 9 days means refused for some *other* reason, and
    // "9 of 7 days" would be nonsense.
    assert.strictEqual(evidenceParts(rowOf({ baselineDays: 9 })).baseline, 'forming · 9 days');
  })) p++; else f++;

  if (test('evidenceParts: the singulars', () => {
    const ev = evidenceParts(rowOf({ intervals: 1, days: 1, utilSum: 2, baselineDays: 1 }));
    assert.strictEqual(ev.current, '1 window · 1 day · 2.0 pts');
    assert.strictEqual(ev.baseline, 'forming · 1 of 7 days');
  })) p++; else f++;

  if (test('waitingText names the model and how far it has got', () => {
    const m = { model: 'claude-sonnet-5' };
    assert.strictEqual(waitingText(rowOf({ ...m, intervals: 2 })), 'claude-sonnet-5 · 2 windows');
    assert.strictEqual(waitingText(rowOf({ ...m, intervals: 1 })), 'claude-sonnet-5 · 1 window');
    assert.strictEqual(waitingText(rowOf({ ...m, intervals: 0 })), 'claude-sonnet-5 · 0 windows');
  })) p++; else f++;

  // ── the coverage bar ──

  /** Every counter zeroed and the start provable — each case moves what it needs. */
  const cov = (over: Partial<UsageCoverage> = {}): UsageCoverage => ({
    movedPct: 100, pricedPct: 0, mixedPct: 0, externalPct: 0,
    preLedgerPct: 0, missingPct: 0, partialPct: 0,
    recorderBreakHours: 0, startProvable: true, ...over
  });

  /** The live 2026-09-06 coverage, the shape the layout was designed against. */
  const LIVE = cov({
    movedPct: 1997, pricedPct: 1171, mixedPct: 152, externalPct: 183,
    preLedgerPct: 438, missingPct: 5, partialPct: 48, recorderBreakHours: 19.4519
  });

  if (test('formatShareOf keeps a decimal under 1%, so a real bucket never reads as 0%', () => {
    assert.strictEqual(formatShareOf(41.8, 100), '42%');
    assert.strictEqual(formatShareOf(0.2, 100), '0.2%');
    assert.strictEqual(formatShareOf(0, 100), '0%');
    assert.strictEqual(formatShareOf(5, 0), '0%', 'a share of nothing is not a division');
  })) p++; else f++;

  if (test('measuredShare is the bar headline, and null when nothing moved', () => {
    assert.strictEqual(measuredShare(LIVE), '59%');
    assert.strictEqual(measuredShare(cov({ movedPct: 0 })), null,
      'a share of nothing is not 0% — the whole block is omitted');
  })) p++; else f++;

  if (test('movedLabel names the denominator in whole points, thousands separated', () => {
    assert.strictEqual(movedLabel(LIVE), 'of 1,997 pts moved');
    assert.strictEqual(movedLabel(cov({ movedPct: 850.4 })), 'of 850 pts moved');
  })) p++; else f++;

  if (test('the live coverage lists every refusal, largest first', () => {
    // External is read from the *bucket*, never from `externalSharePct`: that
    // field divides by the attributable movement (12%), these divide by
    // everything that moved (9%), and only the bucket sums with the bar.
    assert.deepStrictEqual(coverageRows(LIVE), [
      { value: '22%', label: 'predates recording · ages out on its own' },
      { value: '9%', label: 'spent on another device · excluded from the fit' },
      { value: '8%', label: 'no single model held 90% of the tokens' },
      { value: '2%', label: 'windows the recorder only part-covered' },
      { value: '0.3%', label: 'recorder down 19.5 h' }
    ]);
  })) p++; else f++;

  if (test('a bucket that cost nothing produces no row at all', () => {
    assert.deepStrictEqual(coverageRows(cov({ pricedPct: 100 })), [],
      'nothing was refused, so the list says nothing');
    assert.deepStrictEqual(coverageRows(cov({ movedPct: 0 })), []);
  })) p++; else f++;

  if (test('recorder downtime is listed on hours alone, and says 0% honestly', () => {
    // Most breaks overlap no interval at all: time was lost and nothing was
    // spent in it, which is exactly what "0% · recorder down 2.0 h" states.
    assert.deepStrictEqual(coverageRows(cov({ missingPct: 0, recorderBreakHours: 2 })), [
      { value: '0%', label: 'recorder down 2.0 h' }
    ]);
  })) p++; else f++;

  if (test('an unprovable start drops the pre-ledger row and leads with the caveat', () => {
    const rotated = cov({ preLedgerPct: 400, missingPct: 42, startProvable: false });
    const labels = coverageRows(rotated).map(r => r.label).join(' | ');
    assert.ok(!labels.includes('predates'), labels);
    assert.match(coverageCaveat(rotated)!, /rotated/);
    assert.strictEqual(coverageCaveat(cov({ startProvable: true })), null);
  })) p++; else f++;

  // ── the glossary ──

  if (test('the glossary is the single copy of every definition the card shows', () => {
    assert.deepStrictEqual(
      RATES_GLOSSARY.map(g => g.key),
      ['weighted', 'raw', 'fitted', 'baseline', 'window', 'across']
    );
    for (const g of RATES_GLOSSARY) {
      assert.ok(g.term.length > 0 && g.text.length > 0, `${g.key} needs a term and a definition`);
    }
    // The ⓘ panel quotes the drawer verbatim, so there is one string to keep true.
    assert.strictEqual(figureTip('fitted'), RATES_GLOSSARY.find(g => g.key === 'fitted')!.text);
    assert.strictEqual(figureTip('weighted'), RATES_GLOSSARY[0].text);
  })) p++; else f++;

  // ── the table's own columns ──

  if (test("pricedShare: a model's slice of the evidence, summing to 100 across the rows", () => {
    const rows = [
      rowOf({ model: 'a', utilSum: 600 }),
      rowOf({ model: 'b', utilSum: 300 }),
      rowOf({ model: 'c', utilSum: 100 })
    ];
    const shares = rows.map(r => pricedShare(r, rows));
    assert.deepStrictEqual(shares, [60, 30, 10]);
    assert.strictEqual(shares.reduce((n, v) => n + (v ?? 0), 0), 100);
  })) p++; else f++;

  if (test('pricedShare: nothing priced is null, not 0 — a share of nothing is not zero', () => {
    const rows = [rowOf({ utilSum: 0 })];
    assert.strictEqual(pricedShare(rows[0], rows), null);
    assert.strictEqual(pricedShare(rowOf({ utilSum: 5 }), []), null);
    // A negative counter cannot pull a bar backwards out of its cell.
    const odd = [rowOf({ model: 'a', utilSum: -5 }), rowOf({ model: 'b', utilSum: 10 })];
    assert.deepStrictEqual(odd.map(r => pricedShare(r, odd)), [0, 100]);
  })) p++; else f++;

  if (test('formatShare keeps the sub-1% decimal the bar cannot show', () => {
    assert.strictEqual(formatShare(94), '94%');
    assert.strictEqual(formatShare(0.4), '0.4%');
    assert.strictEqual(formatShare(null), '—');
    assert.strictEqual(formatShare(Number.NaN), '—');
  })) p++; else f++;

  if (test('verdictClass: four states, three of them tinted, all distinct', () => {
    const all = (['stable', 'drift', 'mix-shift', 'thin'] as ModelRateVerdict[]).map(verdictClass);
    assert.strictEqual(new Set(all).size, 4);
    for (const c of all) assert.ok(c.startsWith('tag-v'), c);
    assert.strictEqual(verdictClass('thin'), 'tag-v', 'collecting is the bare pill');
  })) p++; else f++;

  // ── the figure strip ──

  if (test('ratesStats: the five figures, in the order the page reads them', () => {
    const models = verdicts('stable', 'drift', 'mix-shift', 'thin', 'thin');
    const tiles = ratesStats(models, LIVE);
    assert.deepStrictEqual(tiles.map(t => t.key),
      ['priced', 'drifting', 'collecting', 'coverage', 'ledger']);
    assert.strictEqual(tiles[0].value, '3', 'stable + drift + mix-shift are priced');
    assert.strictEqual(tiles[1].value, '1');
    assert.strictEqual(tiles[1].warn, true);
    assert.strictEqual(tiles[2].value, '2');
    assert.strictEqual(tiles[3].value, measuredShare(LIVE));
    assert.strictEqual(tiles[3].sub, movedLabel(LIVE));
    assert.strictEqual(tiles[4].value, String(models.length * 585), 'windows, summed');
  })) p++; else f++;

  if (test('ratesStats: nothing drifting is not a warning, and nothing moved is a dash', () => {
    const calm = ratesStats(verdicts('stable', 'stable'), cov({ movedPct: 0 }));
    assert.strictEqual(calm[1].value, '0');
    assert.strictEqual(calm[1].warn, false);
    assert.strictEqual(calm[3].value, '—', 'a share of nothing is not 0%');
    const empty = ratesStats([], cov({ movedPct: 0 }));
    assert.deepStrictEqual(empty.map(t => t.value), ['0', '0', '0', '—', '0']);
  })) p++; else f++;

  // ── the evidence ledger ──

  if (test('spanText names the days and points, never the windows beside it', () => {
    assert.strictEqual(spanText(rowOf({ intervals: 44, days: 1, utilSum: 59 })), '1 day · 59 pts');
    assert.strictEqual(spanText(rowOf({ days: 9, utilSum: 663 })), '9 days · 663 pts');
  })) p++; else f++;

  if (test('ledgerReading: collecting names this row\'s own unmet gates, not the hoisted hint', () => {
    // The hint is identical on every collecting row — printing it per row is
    // what made five rows read as five findings, and the page states it once.
    const hint = verdictText('thin').hint;
    const early = ledgerReading(rowOf({ verdict: 'thin', days: 1, baselineDays: 0 }));
    assert.notStrictEqual(early, hint);
    assert.ok(early.includes('0 of 7 baseline days'), early);
    assert.ok(early.includes('1 of 2 current days'), early);

    const halfway = ledgerReading(rowOf({ verdict: 'thin', days: 4, baselineDays: 3 }));
    assert.ok(halfway.includes('3 of 7 baseline days'), halfway);
    assert.ok(!halfway.includes('current days'), 'a met gate is not listed: ' + halfway);
  })) p++; else f++;

  if (test('ledgerReading: past both day floors and still thin, the refusal is the fit', () => {
    const text = ledgerReading(rowOf({ verdict: 'thin', days: 9, baselineDays: 12, intervals: 6 }));
    assert.ok(text.includes('6 windows'), text);
    assert.ok(text.includes('separate this model'), text);
  })) p++; else f++;

  if (test('ledgerReading: a judged row keeps its own hint, and its weekly line when it has one', () => {
    const drift = ledgerReading(rowOf({ verdict: 'drift' }));
    assert.strictEqual(drift, verdictText('drift').hint, 'no weekly figure, no weekly clause');
    const withWeekly = ledgerReading(rowOf({
      verdict: 'stable',
      weekly: { weightedPerPct: 5600, rawPerPct: null, fittedWeightedPerPct: null,
        verdict: 'fitted', fitVerdict: 'thin', intervals: 3, utilSum: 4, days: 2 }
    }));
    assert.ok(withWeekly.startsWith(verdictText('stable').hint), withWeekly);
    assert.ok(withWeekly.includes('weekly limit'), withWeekly);
  })) p++; else f++;

  if (test('movedTotal is the bare denominator movedLabel wraps', () => {
    assert.strictEqual(movedTotal(cov({ movedPct: 1412.4 })), '1,412');
    assert.strictEqual(movedLabel(cov({ movedPct: 1412.4 })), 'of 1,412 pts moved');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
