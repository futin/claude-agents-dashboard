/**
 * usageRatesFormat.ts — the pure formatting behind the token-value card.
 *
 * Out of the component so the statements the card makes can be tested. Nothing
 * here rounds a *decision* — the verdict arrives from the server.
 *
 * The card is a status board: it answers one question at the top
 * ({@link statusLine}), states each model's figures under their own labels, and
 * puts every definition in one place ({@link RATES_GLOSSARY}). So the functions
 * here return *parts* — a headline and its counts, a current clause and a
 * baseline clause — rather than pre-joined sentences. Where a word inside a
 * clause needs its own emphasis, the component finds it by prefix; the copy
 * still lives here.
 */

import type { ModelRateRow, ModelRateVerdict, UsageCoverage } from '../../../shared/types';
import type { StatTile } from './usageProfile';

/**
 * The day floors a verdict needs, stated once and read by two strings — the
 * `thin` hint and {@link evidenceParts}' `of 7 days`.
 *
 * Deliberately **not** imported from `server/lib/usage-rate.ts`'s
 * `BASELINE_FLOORS`, which is where the number is actually decided: the only
 * thing crossing the FE/BE boundary in this repo is the typed JSON in
 * `shared/types.ts`, and a client module importing server code would be a
 * runtime coupling for one integer. If the server ever moves off 7, this
 * constant is the one place the card has to follow.
 */
const BASELINE_DAY_FLOOR = 7;
const CURRENT_DAY_FLOOR = 2;

/**
 * Tokens, at a magnitude a person can hold in their head. One decimal in the
 * millions, where the interesting numbers live. `—` for null, never `0`:
 * printing zero would claim a measurement that was never fitted.
 */
export function formatTok(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.round(n));
}

/**
 * What a point of the **weekly** limit costs, as one line under the tiles —
 * carrying whichever of the two estimators actually produced a number.
 *
 * `null` — not `—` — when neither did: a line the card omits rather than a dash
 * claiming a measurement nobody made.
 *
 * **Naming the week is the whole point.** Every tile on the row prices the
 * 5-hour window, and a weekly rate is ~8–14× larger, so a line that did not say
 * which window it meant would read as a tenfold drift in the 5-hour rate. It
 * makes **no comparison to the 5-hour rate**: the two are different quantities,
 * and a ratio between them would read as a conversion factor the data does not
 * support — the two clean measurements of it disagree by 57%.
 */
export function weeklyAsideText(
  pooledWeightedPerPct: number | null, fittedWeightedPerPct: number | null
): string | null {
  const usable = (n: number | null): number | null =>
    n !== null && Number.isFinite(n) ? n : null;
  const pooled = usable(pooledWeightedPerPct);
  const fitted = usable(fittedWeightedPerPct);
  if (pooled === null && fitted === null) return null;
  const parts: string[] = [];
  if (pooled !== null) parts.push(`pooled ${formatTok(pooled)}`);
  if (fitted !== null) parts.push(`fitted ${formatTok(fitted)}`);
  return `weekly limit: ${parts.join(' · ')} weighted / 1%`;
}

/** Signed percent, one decimal. The sign is the point, so it is always shown. */
export function formatDeviation(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return (pct < 0 ? '-' : '+') + Math.abs(pct).toFixed(1) + '%';
}

/** "10 windows · 2 days · 5.0 pts" — the evidence a rate rests on, always beside it. */
export function evidenceText(intervals: number, days: number, utilSum: number): string {
  const windows = `${intervals} window${intervals === 1 ? '' : 's'}`;
  return `${windows} · ${dayCount(days)} · ${utilSum.toFixed(1)} pts`;
}

/** "1 day" / "9 days". Split out because three call sites read it. */
function dayCount(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * What the card says about the baseline, in the three states it has.
 *
 * `forming` is the state this function exists for: a baseline can hold days of
 * evidence and still be refused for not holding enough of them, and with every
 * baseline rate null there was nothing on screen telling that apart from a
 * baseline that does not exist yet. That gap is how a one-day baseline came to
 * be badged as drift without disclosing what it was measured against.
 */
export function baselineText(weightedPerPct: number | null, days: number): string {
  if (days <= 0) return 'no baseline yet';
  if (weightedPerPct === null || !Number.isFinite(weightedPerPct)) {
    return `baseline forming · ${dayCount(days)}`;
  }
  return `baseline ${formatTok(weightedPerPct)} · ${dayCount(days)}`;
}

/** Badge copy per verdict. The hint is the sentence the badge cannot fit. */
export function verdictText(verdict: ModelRateVerdict): { label: string; hint: string } {
  switch (verdict) {
    case 'drift':
      return {
        label: 'drift',
        hint: 'the weighted rate has moved more than 20% against the 14-day baseline'
      };
    case 'mix-shift':
      return {
        label: 'mix shift',
        hint: 'the raw token count moved but the weighted rate did not — a change of habit, not a repricing'
      };
    case 'stable':
      return { label: 'stable', hint: 'the weighted rate is within 20% of its baseline' };
    default:
      return {
        label: 'collecting',
        hint: `a verdict needs ${BASELINE_DAY_FLOOR} separate days behind the baseline`
          + ` and ${CURRENT_DAY_FLOOR} behind the current window`
      };
  }
}

/**
 * The question the card answers first, and its answer.
 *
 * **Mix shift is not drift** and never enters the headline: it says the token
 * mix moved while the price did not, which is the opposite of the thing the
 * headline is watching for. It still gets a count, because it is a state a
 * model is in.
 *
 * `null` for an empty list — the "Nothing measurable yet" note stands alone,
 * and "No model is drifting" over no models would be a claim about nothing.
 */
export function statusLine(models: ModelRateRow[]): {
  headline: string; counts: { label: string; n: number }[];
} | null {
  if (models.length === 0) return null;
  const drifting = models.filter(m => m.verdict === 'drift').length;
  const headline = drifting === 0
    ? 'No model is drifting'
    : `${drifting} model${drifting === 1 ? ' is' : 's are'} drifting`;
  // A fixed order, not a frequency sort: the reader learns where to look, and
  // the list is not a ranking. Zero counts are omitted — a row of zeroes reads
  // as a fault, the same rule the coverage list follows.
  const order: ModelRateVerdict[] = ['drift', 'mix-shift', 'stable', 'thin'];
  const counts = order
    .map(v => ({ label: verdictText(v).label, n: models.filter(m => m.verdict === v).length }))
    .filter(c => c.n > 0);
  return { headline, counts };
}

/**
 * Has this model anything to show at all? The rows this refuses go to the fold
 * line rather than rendering three dashes each — a dash is honest for *one*
 * missing figure beside two present ones, and pure noise for a whole row.
 */
export function hasFigures(row: ModelRateRow): boolean {
  return [row.weightedPerPct, row.rawPerPct, row.fittedWeightedPerPct]
    .some(n => n !== null && Number.isFinite(n));
}

/**
 * The evidence line, split in two — the fix for a line that read
 * `baseline forming · 4 days · 585 windows · 4 days · 663.0 pts`, where two
 * identical "4 days" meant two different windows and nothing said which.
 *
 * `forming · N of 7 days` names the floor while the baseline is under it, and
 * stops naming it once past: a baseline that holds 9 days and is still forming
 * is being refused for some *other* reason, and "9 of 7" would be nonsense.
 */
export function evidenceParts(row: ModelRateRow): { current: string; baseline: string } {
  const current = evidenceText(row.intervals, row.days, row.utilSum);
  const rate = row.baselineWeightedPerPct;
  if (row.baselineDays <= 0) return { current, baseline: 'none yet' };
  if (rate === null || !Number.isFinite(rate)) {
    return {
      current,
      baseline: row.baselineDays < BASELINE_DAY_FLOOR
        ? `forming · ${row.baselineDays} of ${BASELINE_DAY_FLOOR} days`
        : `forming · ${dayCount(row.baselineDays)}`
    };
  }
  return { current, baseline: `${formatTok(rate)} · ${dayCount(row.baselineDays)}` };
}

/** One model on the fold line: what it is, and how far it has got. */
export function waitingText(row: ModelRateRow): string {
  return `${row.model} · ${row.intervals} window${row.intervals === 1 ? '' : 's'}`;
}

/**
 * One bucket's share of everything that moved. One decimal under 1%, because a
 * real 0.2% rounded to `0%` reads as a bucket that is empty — and the whole
 * point of the split is that one of these buckets is genuinely tiny.
 */
export function formatShareOf(points: number, movedPct: number): string {
  if (movedPct <= 0 || !Number.isFinite(points / movedPct)) return '0%';
  const pct = (points / movedPct) * 100;
  return pct > 0 && pct < 1 ? pct.toFixed(1) + '%' : Math.round(pct) + '%';
}

/**
 * The coverage bar's headline: how much of the measured movement actually
 * reached a rate. Null when nothing moved — a share of nothing is not 0%, and
 * the whole block is omitted rather than drawn empty.
 */
export function measuredShare(coverage: UsageCoverage): string | null {
  if (coverage.movedPct <= 0) return null;
  return formatShareOf(coverage.pricedPct, coverage.movedPct);
}

/** The denominator as a bare figure. `en-US` explicitly, so tests pin it. */
export function movedTotal(coverage: UsageCoverage): string {
  return Math.round(coverage.movedPct).toLocaleString('en-US');
}

/** The denominator, in the reader's words. */
export function movedLabel(coverage: UsageCoverage): string {
  return `of ${movedTotal(coverage)} pts moved`;
}

/**
 * The refusals, largest first, each named for its cause — and **only** the ones
 * that cost something: a row of zeroes reads as a fault.
 *
 * `external` is listed from `coverage.externalPct`, never from the response's
 * `externalSharePct`. The two are different denominators, not a discrepancy:
 * `externalSharePct` divides by the *attributable* movement, these buckets
 * divide by everything that moved. Reading the bucket is what makes this list
 * sum with the bar above it.
 *
 * Recorder downtime is listed whenever *either* counter is non-zero, so `0%`
 * can appear beside real hours. That is the correct statement and not a
 * rounding artifact: most breaks overlap no interval at all, so time was lost
 * and nothing was spent in it.
 */
export function coverageRows(coverage: UsageCoverage): { value: string; label: string }[] {
  const { movedPct, startProvable } = coverage;
  if (movedPct <= 0) return [];
  const share = (points: number): string => formatShareOf(points, movedPct);
  const ranked: { points: number; value: string; label: string }[] = [];

  if (startProvable && coverage.preLedgerPct > 0) {
    ranked.push({
      points: coverage.preLedgerPct,
      value: share(coverage.preLedgerPct),
      label: 'predates recording · ages out on its own'
    });
  }
  if (coverage.externalPct > 0) {
    ranked.push({
      points: coverage.externalPct,
      value: share(coverage.externalPct),
      label: 'spent on another device · excluded from the fit'
    });
  }
  if (coverage.mixedPct > 0) {
    ranked.push({
      points: coverage.mixedPct,
      value: share(coverage.mixedPct),
      label: 'no single model held 90% of the tokens'
    });
  }
  if (coverage.partialPct > 0) {
    ranked.push({
      points: coverage.partialPct,
      value: share(coverage.partialPct),
      label: 'windows the recorder only part-covered'
    });
  }
  if (coverage.missingPct > 0 || coverage.recorderBreakHours > 0) {
    ranked.push({
      points: coverage.missingPct,
      value: share(coverage.missingPct),
      label: `recorder down ${coverage.recorderBreakHours.toFixed(1)} h`
    });
  }
  ranked.sort((a, b) => b.points - a.points);
  return ranked.map(({ value, label }) => ({ value, label }));
}

/**
 * The caveat that qualifies every row above rather than adding to them: with the
 * start of recording unprovable, nothing may be claimed as pre-ledger and
 * `missingPct` has absorbed whatever predates it. Null when the start is known.
 */
export function coverageCaveat(coverage: UsageCoverage): string | null {
  if (coverage.startProvable) return null;
  return 'The ledger has rotated, so the start of recording is unknown — whatever '
    + 'predates it is counted as recorder downtime below.';
}

/**
 * Every definition the card owns, in one place, read by two renderers: the
 * `How to read this` drawer prints all six, and the ⓘ beside a figure label
 * opens the matching one. One copy of each string, so the drawer and the panel
 * cannot drift apart.
 */
export const RATES_GLOSSARY: readonly {
  key: 'weighted' | 'raw' | 'fitted' | 'baseline' | 'window' | 'across';
  term: string;
  text: string;
}[] = [
  {
    key: 'weighted',
    term: 'Weighted rate',
    text: 'Tokens per 1% of the limit, with each token type weighted by what it '
      + 'costs the window. Mix-invariant, so a change here is a real repricing. '
      + 'Drift is judged on this and nothing else.'
  },
  {
    key: 'raw',
    term: 'Raw tokens',
    text: "The same 1% in plain token counts, at the model's recent mix. Moves "
      + 'when the cache-read habit moves, so it is a translation, not a price.'
  },
  {
    key: 'fitted',
    term: 'Fitted',
    text: 'A second estimate of the weighted rate, measured jointly across the '
      + 'windows where several models ran together. Reads more of the evidence, '
      + 'has no baseline yet. The only figure a subagent-only model ever gets.'
  },
  {
    key: 'baseline',
    term: 'Baseline',
    text: `The trailing 14 days before the last three. A verdict needs ${BASELINE_DAY_FLOOR} `
      + 'separate days in it.'
  },
  {
    key: 'window',
    term: 'Window · pts',
    text: 'One window is one 5-hour limit period that one model owned (≥90% of '
      + 'tokens). pts are the utilization percentage points those windows moved '
      + 'in total.'
  },
  {
    key: 'across',
    term: 'Across models',
    text: 'Not a price list. A model that fires more requests per token carries '
      + 'that per-request cost inside its rate, so rates compare a model to its '
      + 'own past, not to another model.'
  }
];

/** The definition behind one figure's ⓘ — the same string the drawer prints. */
export function figureTip(key: typeof RATES_GLOSSARY[number]['key']): string {
  return RATES_GLOSSARY.find(g => g.key === key)!.text;
}

/**
 * This model's share of the spend a rate was actually fitted on.
 *
 * The denominator is the *priced* total — the sum of the rows' own `utilSum` —
 * not everything that moved. Those are different questions, and this column is
 * answering "of the evidence behind these rates, how much is this model's",
 * which is the one that makes the bars in the column read as a single
 * breakdown summing to the priced share underneath them.
 *
 * Null, not 0, when there is nothing priced: a share of nothing is not zero.
 */
export function pricedShare(row: ModelRateRow, models: ModelRateRow[]): number | null {
  const total = models.reduce((n, m) => n + Math.max(0, m.utilSum), 0);
  if (!(total > 0)) return null;
  return Math.min(100, Math.max(0, (Math.max(0, row.utilSum) / total) * 100));
}

/** A share as the table prints it. `—` for the null the column is honest about. */
export function formatShare(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return pct > 0 && pct < 1 ? pct.toFixed(1) + '%' : Math.round(pct) + '%';
}

/** The verdict pill's modifier class — the table's four states. */
export function verdictClass(verdict: ModelRateVerdict): string {
  switch (verdict) {
    case 'stable': return 'tag-v stable';
    case 'drift': return 'tag-v drift';
    case 'mix-shift': return 'tag-v mix';
    default: return 'tag-v';
  }
}

/**
 * The token-value page's five figures: how many models are priced, how many
 * have moved, how many are still collecting, how much of the spend reached a
 * rate at all, and how many windows are behind the whole thing.
 *
 * Counts of *models* on the left, points and windows on the right — the strip
 * reads left to right as "what the fit concluded, then what it read".
 */
export function ratesStats(models: ModelRateRow[], coverage: UsageCoverage): StatTile[] {
  const n = (v: ModelRateVerdict) => models.filter(m => m.verdict === v).length;
  const drifting = n('drift');
  const windows = models.reduce((sum, m) => sum + m.intervals, 0);
  const measured = measuredShare(coverage);
  return [
    {
      key: 'priced',
      label: 'Priced',
      value: String(n('stable') + drifting + n('mix-shift')),
      sub: drifting === 0 ? 'no rate has moved' : 'not all of them holding'
    },
    {
      key: 'drifting',
      label: 'Drifting',
      value: String(drifting),
      warn: drifting > 0,
      sub: drifting === 0 ? 'every rate within its baseline' : 'moved past the baseline spread'
    },
    {
      key: 'collecting',
      label: 'Collecting',
      value: String(n('thin')),
      sub: n('thin') === 0 ? 'nothing waiting on evidence' : 'not enough windows yet'
    },
    {
      key: 'coverage',
      label: 'Coverage',
      value: measured ?? '—',
      sub: coverage.movedPct > 0 ? movedLabel(coverage) : 'nothing has moved yet'
    },
    {
      key: 'ledger',
      label: 'Ledger',
      value: String(windows),
      sub: windows === 1 ? 'recorded window' : 'recorded windows'
    }
  ];
}

/**
 * The evidence ledger's span column: what the current fit read, without
 * repeating the window count standing in the cell beside it.
 */
export function spanText(row: ModelRateRow): string {
  return `${dayCount(row.days)} · ${row.utilSum.toFixed(0)} pts`;
}

/**
 * The ledger's reading for one model — a fact about *this* row, never the
 * hoisted one.
 *
 * `collecting` is the case that forces the distinction. Its hint is a statement
 * about the measurement, identical on every row, and printing it per row is
 * what made five rows read as five separate findings; the page states it once,
 * above the table. What belongs here instead is the row's own distance from the
 * gates — which floor it is short of, in its own numbers. Drift and mix-shift
 * hints stay: those *are* facts about one model.
 */
export function ledgerReading(row: ModelRateRow): string {
  if (row.verdict !== 'thin') {
    const weekly = weeklyAsideText(row.weekly.weightedPerPct, row.weekly.fittedWeightedPerPct);
    return weekly === null ? verdictText(row.verdict).hint
      : `${verdictText(row.verdict).hint}. ${weekly}`;
  }
  // Both gates, with this row's own counts — the baseline first, because it is
  // the one that takes a fortnight and therefore the one still unmet at the end.
  const parts: string[] = [];
  if (row.baselineDays < BASELINE_DAY_FLOOR) {
    parts.push(`${row.baselineDays} of ${BASELINE_DAY_FLOOR} baseline days`);
  }
  if (row.days < CURRENT_DAY_FLOOR) {
    parts.push(`${row.days} of ${CURRENT_DAY_FLOOR} current days`);
  }
  if (parts.length === 0) {
    // Past both day floors and still collecting: the refusal is the window
    // count or a fit that could not tell this model from the ones beside it.
    return `${row.intervals} window${row.intervals === 1 ? '' : 's'}, not yet enough to `
      + 'separate this model from the ones it runs beside';
  }
  return `waiting on ${parts.join(' and ')}`;
}
