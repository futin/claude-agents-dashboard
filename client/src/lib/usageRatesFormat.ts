/**
 * usageRatesFormat.ts — the pure formatting behind the token-value card.
 *
 * Kept out of the component for the usual reason in this codebase: these are
 * the statements the card makes, and a statement worth making is worth a test.
 * Nothing here rounds a *decision* — the verdict arrives from the server; this
 * only decides how many digits a reader can act on.
 */

import type { ModelRateVerdict } from '../../../shared/types';

/**
 * Tokens, at a magnitude a person can hold in their head.
 *
 * Three digits at most, and **one decimal in the millions** — the range the
 * interesting numbers live in, where `1.5M` and `2.0M` are a distinction worth
 * drawing and `1_500_000` is not. `—` for null, never `0`: an unfitted rate is
 * an absence, and printing zero would claim a measurement.
 */
export function formatTok(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.round(n));
}

/** Signed percent, one decimal. The sign is the point, so it is always shown. */
export function formatDeviation(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return (pct < 0 ? '-' : '+') + Math.abs(pct).toFixed(1) + '%';
}

/** "10 windows · 5.0 pts" — the evidence a rate rests on, always beside it. */
export function evidenceText(intervals: number, utilSum: number): string {
  const windows = `${intervals} window${intervals === 1 ? '' : 's'}`;
  return `${windows} · ${utilSum.toFixed(1)} pts`;
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
      return { label: 'collecting', hint: 'not enough measured windows yet to fit a rate' };
  }
}

/** "12% external" for the footer pill, or null when nothing moved to measure. */
export function formatSharePct(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  return `${Math.round(pct)}%`;
}
