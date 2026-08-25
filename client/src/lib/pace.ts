/**
 * pace.ts — pure view-model for the usage bars' time strip (design "B").
 *
 * The server sends per-window burn rate + projected exhaustion (usage-pace.ts);
 * this derives what the strip actually draws: where "now" sits inside the
 * window, where the projected wall tick lands, and the wall/lasts verdict.
 * Pure so it's unit-testable (test/pace-view.test.ts).
 */

import type { ForecastConfidence, RateLimit } from '../../../shared/types';

export const FIVE_HOUR_MS = 5 * 3_600_000;
export const SEVEN_DAY_MS = 7 * 24 * 3_600_000;

export interface PaceView {
  /** 0–100: how far through the window "now" is (the elapsed fill). */
  elapsedPct: number;
  /** 0–100 position of the projected-wall tick, or null (no wall before reset). */
  wallPct: number | null;
  /**
   * Same, for the pessimistic edge — the projection that assumes every
   * remaining hour is worked. The two ticks bracket the band the strip draws.
   * Null under exactly the same conditions as {@link wallPct}.
   */
  wallPctPessimistic: number | null;
  /** How far to trust the gap between the two ticks. 'none' without a profile. */
  confidence: ForecastConfidence;
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

/**
 * The rate, in the unit that window is read in.
 *
 * The weekly figure is a *daily* one, and `perHour` is percent per **active**
 * hour — so it has to be scaled by the duty cycle before the ×24, or a typical
 * profile overstates the day by about 3.4×. Without a duty cycle (recording off)
 * the rate is the plain wall slope and 1.0 is the right multiplier, which is
 * also exactly the old formula.
 */
function fmtRate(perHour: number, windowMs: number, dutyCycle?: number | null): string {
  const perDay = windowMs > 24 * 3_600_000;
  const v = perDay ? perHour * (dutyCycle ?? 1) * 24 : perHour;
  const text = v > 0 && v < 1 ? v.toFixed(1) : String(Math.round(v));
  return `${text}%/${perDay ? 'day' : 'h'}`;
}

/** A projected-exhaust ISO stamp as a 0–100 strip position, or null. */
function tickPct(iso: string | null | undefined, start: number, end: number, windowMs: number): number | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at) || at >= end) return null; // absent, unparseable, or past the reset
  return clampPct(((at - start) / windowMs) * 100);
}

/** Derive the time-strip view for one window; null when resetsAt is unknown. */
export function paceView(rl: RateLimit, windowMs: number, now = Date.now()): PaceView | null {
  if (!rl.resetsAt) return null;
  const end = Date.parse(rl.resetsAt);
  if (Number.isNaN(end)) return null;
  const start = end - windowMs;
  const elapsedPct = clampPct(((now - start) / windowMs) * 100);

  const confidence = rl.forecastConfidence ?? 'none';
  const wallPctPessimistic = tickPct(rl.pessimisticExhaustAt, start, end, windowMs);

  const rate = rl.ratePerHour;
  if (rate == null) {
    return {
      elapsedPct, wallPct: null, wallPctPessimistic, confidence,
      verdict: null, rateText: null, startMs: start, wallMs: null
    };
  }

  const rateText = fmtRate(rate, windowMs, rl.dutyCycle);
  const wall = rl.projectedExhaustAt ? Date.parse(rl.projectedExhaustAt) : NaN;
  if (!Number.isNaN(wall) && wall < end) {
    return {
      elapsedPct,
      wallPct: clampPct(((wall - start) / windowMs) * 100),
      wallPctPessimistic,
      confidence,
      verdict: 'wall',
      rateText,
      startMs: start,
      wallMs: wall
    };
  }
  return {
    elapsedPct, wallPct: null, wallPctPessimistic, confidence,
    verdict: 'lasts', rateText, startMs: start, wallMs: null
  };
}
