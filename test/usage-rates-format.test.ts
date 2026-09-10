import assert from 'node:assert';

import type { ModelDayRate, ModelRateRow, ModelRateVerdict, UsageCoverage } from '../shared/types.js';
import {
  baselineText,
  coverageCaveat,
  coverageRows,
  cutFraction,
  dayLabel,
  dayStep,
  dayTip,
  evidenceParts,
  evidenceText,
  figureTip,
  formatDeviation,
  formatShareOf,
  formatTok,
  hasFigures,
  measuredShare,
  movedLabel,
  RATES_GLOSSARY,
  showsDays,
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
    daily: [],
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
      ['weighted', 'raw', 'fitted', 'baseline', 'daily', 'window', 'across']
    );
    for (const g of RATES_GLOSSARY) {
      assert.ok(g.term.length > 0 && g.text.length > 0, `${g.key} needs a term and a definition`);
    }
    // The ⓘ panel quotes the drawer verbatim, so there is one string to keep true.
    assert.strictEqual(figureTip('fitted'), RATES_GLOSSARY.find(g => g.key === 'fitted')!.text);
    assert.strictEqual(figureTip('weighted'), RATES_GLOSSARY[0].text);
  })) p++; else f++;

  // ── the day strip ──────────────────────────────────────────────────────

  const day = (over: Partial<ModelDayRate>): ModelDayRate => ({
    date: '2026-09-08', weightedPerPct: 137_344, rawPerPct: 848_000, intervals: 131,
    utilSum: 151, deviationPct: -39.9, state: 'rated', ...over
  });
  const rowWith = (over: Partial<ModelRateRow>): ModelRateRow => ({
    model: 'claude-opus-5', rawPerPct: 875_000, weightedPerPct: 141_000,
    baselineRawPerPct: 1_300_000, baselineWeightedPerPct: 228_461, deviationPct: -38.1,
    verdict: 'drift', intervals: 257, utilSum: 301, days: 4, baselineDays: 8,
    pctPerMWeighted: null, pctPerRequest: null, splitVerdict: 'thin',
    fittedWeightedPerPct: 281_000, fitVerdict: 'fitted', fitDeviationPct: 99,
    weekly: {
      weightedPerPct: null, rawPerPct: null, fittedWeightedPerPct: null,
      verdict: 'thin', fitVerdict: 'thin', intervals: 0, utilSum: 0, days: 0
    },
    daily: [day({})],
    ...over
  });

  if (test("dayStep: the ±20% band is the verdict's, and the boundaries fall the same way", () => {
    // `driftRow` calls drift on `|dev| > 20`, so exactly 20 is within — here too.
    assert.strictEqual(dayStep(0), 'within');
    assert.strictEqual(dayStep(20), 'within');
    assert.strictEqual(dayStep(-20), 'within');
    assert.strictEqual(dayStep(20.001), 'above');
    assert.strictEqual(dayStep(-20.001), 'below');
    assert.strictEqual(dayStep(40), 'above');
    assert.strictEqual(dayStep(-40), 'below');
    assert.strictEqual(dayStep(40.001), 'far-above');
    assert.strictEqual(dayStep(-40.001), 'far-below');
    assert.strictEqual(dayStep(null), 'unjudged');
    assert.strictEqual(dayStep(Number.NaN), 'unjudged');
  })) p++; else f++;

  if (test('dayLabel: month and day, no year, UTC', () => {
    assert.strictEqual(dayLabel('2026-09-08'), 'Sep 8');
    assert.strictEqual(dayLabel('2026-08-24'), 'Aug 24');
    assert.strictEqual(dayLabel('2026-12-31'), 'Dec 31');
  })) p++; else f++;

  if (test('dayTip: a rated day states rate, deviation and evidence, one per line', () => {
    assert.strictEqual(
      dayTip(day({}), '2026-09-10'),
      'Sep 8 (UTC)\n137k weighted tok / 1%\n-39.9% vs baseline\n131 windows · 151.0 pts'
    );
  })) p++; else f++;

  if (test('dayTip: today says so, a single window is singular, no baseline drops the comparison', () => {
    const today = day({ date: '2026-09-10', deviationPct: null, intervals: 1, utilSum: 7, weightedPerPct: 60_000 });
    assert.strictEqual(
      dayTip(today, '2026-09-10'),
      'Sep 10 (UTC) · today so far\n60k weighted tok / 1%\n1 window · 7.0 pts'
    );
  })) p++; else f++;

  if (test('dayTip: a thin day carries its figures and says why it is not coloured', () => {
    const thin = day({ date: '2026-09-10', state: 'thin', intervals: 3, utilSum: 3, weightedPerPct: 396_000, deviationPct: 73.3 });
    assert.strictEqual(
      dayTip(thin, '2026-09-11'),
      'Sep 10 (UTC)\n396k weighted tok / 1%\n+73.3% vs baseline\n3 windows · 3.0 pts\nunder 5 pts — not coloured'
    );
  })) p++; else f++;

  if (test('dayTip: none and pre-ledger are one sentence each, no figures', () => {
    const blank = { weightedPerPct: null, rawPerPct: null, intervals: 0, utilSum: 0, deviationPct: null } as const;
    assert.strictEqual(
      dayTip(day({ date: '2026-09-01', state: 'none', ...blank }), '2026-09-10'),
      'Sep 1 (UTC)\nno windows this model owned'
    );
    assert.strictEqual(
      dayTip(day({ date: '2026-08-27', state: 'pre-ledger', ...blank }), '2026-09-10'),
      'Aug 27 (UTC)\nbefore recording began'
    );
  })) p++; else f++;

  if (test('cutFraction: the −3d boundary at its true position along the strip', () => {
    const daily = Array.from({ length: 18 }, (_, i) =>
      day({ date: new Date(Date.UTC(2026, 7, 24 + i)).toISOString().slice(0, 10) }));
    // 24 Aug 00:00 → 11 Sep 00:00 is 18 days; the cut is 7 Sep 11:30 = 14 d 11.5 h in.
    const frac = cutFraction(daily, '2026-09-10T11:30:00.000Z')!;
    assert.ok(Math.abs(frac - 347.5 / 432) < 1e-6, String(frac));
    assert.strictEqual(cutFraction([], '2026-09-10T11:30:00.000Z'), null);
  })) p++; else f++;

  if (test('showsDays: only a row with a baseline draws the strip', () => {
    assert.strictEqual(showsDays(rowWith({})), true);
    assert.strictEqual(showsDays(rowWith({ baselineWeightedPerPct: null })), false);
    assert.strictEqual(showsDays(rowWith({ daily: [] })), false);
  })) p++; else f++;

  if (test('the glossary defines the strip, and the ⓘ reads the same string', () => {
    const entry = RATES_GLOSSARY.find(g => g.key === 'daily');
    assert.ok(entry !== undefined && entry.text.length > 0);
    assert.strictEqual(figureTip('daily'), entry!.text);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
