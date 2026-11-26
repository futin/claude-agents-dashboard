/** The account chip's gauge rules — which bars draw, how full, what colour, and what a signed-out or expired status says — out of `HeaderAccount.tsx`. */
import type { UsageLimits, UsageStatus } from '../../../shared/types';
import { FIVE_HOUR_MS, SEVEN_DAY_MS } from './pace';

/**
 * The rate-limit bars worth drawing — those with a utilization reading.
 * `short` is the chip's label, which has 52px for it; `label` is the popover's.
 */
export function usageBars(usage: UsageLimits | null | undefined) {
  if (!usage) return [];
  return [
    { label: '5h', short: '5H', rl: usage.fiveHour, windowMs: FIVE_HOUR_MS },
    { label: 'Week', short: 'WK', rl: usage.sevenDay, windowMs: SEVEN_DAY_MS }
  ].filter((b) => b.rl.utilization != null);
}

/** '' · mid · high — the ramp the fill, the figure and the strip all colour by. */
export type Level = '' | 'mid' | 'high';

/** A utilization reading as a whole percent the gauge can draw: rounded, then held to 0–100. */
export const clampPct = (u: number): number => Math.max(0, Math.min(100, Math.round(u)));
/** The level a clamped percent colours at: `high` from 90, `mid` from 60. */
export const gaugeLevel = (pct: number): Level => (pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '');

export interface OutState {
  /** What the chip says beside the ring. */
  chip: string;
  title: string;
  body: string;
  /** The one command that fixes it, or null when there is nothing to run. */
  command: string | null;
  note: string;
}

/**
 * The two statuses the reader can act on. `ok` and `unavailable` return null —
 * the first has gauges to draw, and the second has nothing worth saying.
 */
export function outState(status: UsageStatus | undefined): OutState | null {
  if (status === 'signed-out') {
    return {
      chip: 'Signed out',
      title: 'Not signed in',
      body: 'The stored credential is there but blank, so the account usage endpoint has '
        + 'nothing to answer with: no name, no rate windows, no forecast. Sign in from a '
        + 'terminal — this board cannot do it for you.',
      command: 'claude auth login',
      note: 'The dashboard is read-only here: it can name the command, not run it.'
    };
  }
  if (status === 'token-expired') {
    return {
      chip: 'Token expired',
      title: 'Token expired',
      body: 'The stored OAuth token is past its expiry, so the usage endpoint refuses it. '
        + 'Nothing to do — it renews itself on one of the next polls and the gauges come back.',
      command: null,
      note: 'If it stays expired, the refresh token is gone too: sign in again from a terminal.'
    };
  }
  return null;
}
