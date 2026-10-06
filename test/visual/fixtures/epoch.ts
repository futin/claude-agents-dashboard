/**
 * The one instant every visual shot is taken at. A Wednesday afternoon, so hour-of-week charts have filled columns before it. `stage` freezes the page clock
 * here and the config pins `timezoneId: 'UTC'`, so EPOCH and the zone are one pair: relative text ("3m ago") and local wall-clock text never move.
 */
export const EPOCH = Date.parse('2026-09-30T14:00:00Z');

/** `EPOCH` minus `ms`. Every fixture timestamp is one of these. */
export function ago(ms: number): number {
  return EPOCH - ms;
}

/** ISO 8601 form of `ago(ms)`. */
export function agoIso(ms: number): string {
  return new Date(ago(ms)).toISOString();
}

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
