/**
 * pace.ts — pure view-model for the usage bars' time strip (design "B").
 *
 * The server sends per-window burn rate + projected exhaustion (usage-pace.ts);
 * this derives what the strip actually draws: where "now" sits inside the
 * window, where the projected wall tick lands, and the wall/lasts verdict.
 * Pure so it's unit-testable (test/pace-view.test.ts).
 */

import type { RateLimit } from '../../../shared/types';

export const FIVE_HOUR_MS = 5 * 3_600_000;
export const SEVEN_DAY_MS = 7 * 24 * 3_600_000;

export interface PaceView {
  /** 0–100: how far through the window "now" is (the elapsed fill). */
  elapsedPct: number;
  /** 0–100 position of the projected-wall tick, or null (no wall before reset). */
  wallPct: number | null;
  /** 'wall' = projected to hit 100% before the reset; 'lasts' = coasts through;
   *  null = not enough pace history yet. */
  verdict: 'wall' | 'lasts' | null;
  /** "22%/h" (5h window) / "6%/day" (weekly), or null without pace data. */
  rateText: string | null;
  /** Epoch ms of the window start (resetsAt − window length). */
  startMs: number;
  /** Epoch ms of the projected wall, when verdict is 'wall'. */
  wallMs: number | null;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

function fmtRate(perHour: number, windowMs: number): string {
  const perDay = windowMs > 24 * 3_600_000;
  const v = perDay ? perHour * 24 : perHour;
  const text = v > 0 && v < 1 ? v.toFixed(1) : String(Math.round(v));
  return `${text}%/${perDay ? 'day' : 'h'}`;
}

/** Derive the time-strip view for one window; null when resetsAt is unknown. */
export function paceView(rl: RateLimit, windowMs: number, now = Date.now()): PaceView | null {
  if (!rl.resetsAt) return null;
  const end = Date.parse(rl.resetsAt);
  if (Number.isNaN(end)) return null;
  const start = end - windowMs;
  const elapsedPct = clampPct(((now - start) / windowMs) * 100);

  const rate = rl.ratePerHour;
  if (rate == null) {
    return { elapsedPct, wallPct: null, verdict: null, rateText: null, startMs: start, wallMs: null };
  }

  const rateText = fmtRate(rate, windowMs);
  const wall = rl.projectedExhaustAt ? Date.parse(rl.projectedExhaustAt) : NaN;
  if (!Number.isNaN(wall) && wall < end) {
    return {
      elapsedPct,
      wallPct: clampPct(((wall - start) / windowMs) * 100),
      verdict: 'wall',
      rateText,
      startMs: start,
      wallMs: wall
    };
  }
  return { elapsedPct, wallPct: null, verdict: 'lasts', rateText, startMs: start, wallMs: null };
}
