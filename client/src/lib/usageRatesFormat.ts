/**
 * usageRatesFormat.ts — the pure formatting behind the token-value card.
 *
 * Out of the component so the statements the card makes can be tested. Nothing
 * here rounds a *decision* — the verdict arrives from the server.
 */

import type { ModelRateVerdict, UsageCoverage } from '../../../shared/types';

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
 * The raw rate as an aside, named for what it is: a translation that moves with
 * the model's cache-read habit, not a price. `null` — not `—` — when there is
 * no raw rate, because a translation of nothing is a line the card should omit.
 */
export function rawAsideText(rawPerPct: number | null): string | null {
  if (rawPerPct === null || !Number.isFinite(rawPerPct)) return null;
  return `≈ ${formatTok(rawPerPct)} raw at this model's recent mix`;
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
        hint: 'a verdict needs 7 separate days behind the baseline and 2 behind the current window'
      };
  }
}

/** "12% external" for the footer pill, or null when nothing moved to measure. */
export function formatSharePct(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `${Math.round(pct)}%`;
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
 * The honest headline: how much of the measured movement actually reached a
 * rate. Null when nothing moved — a share of nothing is not 0%.
 */
export function pricedPillText(coverage: UsageCoverage): string | null {
  if (coverage.movedPct <= 0) return null;
  return `${formatShareOf(coverage.pricedPct, coverage.movedPct)} priced`;
}

/**
 * The refusals, largest first, each named for its cause — and **only** the ones
 * that cost something: a row of zeroes reads as a fault.
 *
 * `external` is deliberately not among them; it has its own pill beside this
 * row already. When the start of recording cannot be proven the pre-ledger
 * clause is replaced by a caveat that leads, because it qualifies every other
 * number here rather than adding to them.
 */
export function coverageClauses(coverage: UsageCoverage): string[] {
  const { movedPct, startProvable } = coverage;
  if (movedPct <= 0) return [];
  const share = (points: number): string => formatShareOf(points, movedPct);
  const out: string[] = [];

  if (!startProvable) {
    out.push('the ledger has rotated, so the start of recording is unknown — '
      + 'whatever predates it is counted as recorder downtime below');
  }

  const ranked: { points: number; text: string }[] = [];
  if (startProvable && coverage.preLedgerPct > 0) {
    ranked.push({
      points: coverage.preLedgerPct,
      text: `${share(coverage.preLedgerPct)} predates recording — ages out on its own`
    });
  }
  if (coverage.missingPct > 0 || coverage.recorderBreakHours > 0) {
    // The hours and the points together, always: 12.4 h beside nothing reads
    // as 12.4 h of lost spend, which is the misreading this task exists to fix.
    ranked.push({
      points: coverage.missingPct,
      text: `recorder down ${coverage.recorderBreakHours.toFixed(1)} h`
        + ` — cost ${share(coverage.missingPct)} of what moved`
    });
  }
  if (coverage.partialPct > 0) {
    ranked.push({
      points: coverage.partialPct,
      text: `${share(coverage.partialPct)} from windows the recorder only part-covered`
    });
  }
  if (coverage.mixedPct > 0) {
    ranked.push({
      points: coverage.mixedPct,
      text: `${share(coverage.mixedPct)} with no model holding 90% of the tokens`
    });
  }
  ranked.sort((a, b) => b.points - a.points);
  return [...out, ...ranked.map(r => r.text)];
}
