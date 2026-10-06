/**
 * The one invented usage story every usage fixture tells, so the account bars, the forecast walk and the history chart agree with each other.
 * Weekly window Fri 26 Sep 02:00Z → Fri 3 Oct 02:00Z, 46% used at EPOCH; 5-hour window 11:00Z → 16:00Z, 38% used. The page clock is UTC, so
 * hour-of-week here is UTC too.
 */
import { DAY, EPOCH, HOUR } from './epoch.js';

export const WEEK_RESETS_MS = EPOCH + 2 * DAY + 12 * HOUR;
export const WEEK_UTIL = 46;
export const FIVE_RESETS_MS = EPOCH + 2 * HOUR;
export const FIVE_UTIL = 38;
/** Percent of the weekly window per active hour. */
export const WEEK_RATE = 2.5;

/** Expected active share of one hour-of-week bucket (0 = Sunday 00:00), or null for the untrusted weekend-night buckets. */
export function weightFor(hourOfWeek: number): number | null {
  const day = Math.floor(hourOfWeek / 24);
  const hour = hourOfWeek % 24;
  const weekend = day === 0 || day === 6;
  if (weekend) return hour >= 10 && hour <= 17 ? 0.12 : hour < 6 ? null : 0.03;
  if (hour >= 8 && hour <= 18) return Math.round((0.6 + 0.3 * (((hour * 7 + day * 3) % 5) / 4)) * 100) / 100;
  if (hour >= 19 && hour <= 22) return 0.25;
  return 0.02;
}

export function hourOfWeekAt(ms: number): number {
  const d = new Date(ms);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

export const GLOBAL_MEAN = 0.3;

const iso = (ms: number): string => new Date(ms).toISOString();

/** The forward walk from EPOCH to the weekly reset, one step per hour. */
export function forecastWalk(): { walk: { t: string; gain: number; cum: number; weight: number; learned: boolean }[]; dutyCycle: number } {
  const walk = [];
  let cum = WEEK_UTIL;
  let weightSum = 0;
  for (let t = EPOCH; t < WEEK_RESETS_MS; t += HOUR) {
    const learned = weightFor(hourOfWeekAt(t));
    const weight = learned ?? GLOBAL_MEAN;
    const gain = Math.round(weight * WEEK_RATE * 100) / 100;
    cum = Math.round((cum + gain) * 100) / 100;
    weightSum += weight;
    walk.push({ t: iso(t), gain, cum, weight, learned: learned !== null });
  }
  return { walk, dutyCycle: Math.round((weightSum / walk.length) * 1000) / 1000 };
}
