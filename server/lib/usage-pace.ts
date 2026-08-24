/**
 * usage-pace.ts — burn rate + projected exhaustion for the account usage bars.
 *
 * The OAuth usage endpoint only ever says "X% used, resets at T" — nothing
 * about pace. But usage.ts already samples it ~once a minute, so this module
 * keeps a small RAM-only history of (time, utilization) per window and turns
 * it into `%/hour` + "at this pace you hit 100% at T'". The 5h window is a
 * fixed session anchored at its first message (verified empirically: resets_at
 * stays constant while utilization climbs, and drops to 0 at the boundary), so
 * samples from a previous window are pruned by the anchor (resetsAt − length)
 * and by any utilization drop.
 *
 * Pure math (computePace/prunedSamples) is separated from the module-level
 * store (recordAndPace) so the math is unit-testable with fixed clocks.
 * Everything fails open: not enough history yet → pace fields are null and
 * the header simply renders what it always did.
 */

import type { RateLimit } from '../../shared/types.js';

export interface PaceSample {
  /** Sample time, ms epoch. */
  t: number;
  /** Utilization percent at that time (0–100). */
  utilization: number;
}

export interface PaceOpts {
  /** Only samples newer than now − lookbackMs feed the slope. */
  lookbackMs: number;
  /** Minimum first→last span before a slope is trusted. */
  minSpanMs: number;
  now: number;
}

export interface Pace {
  ratePerHour: number;
  projectedExhaustAt: string | null;
}

const HOUR_MS = 3_600_000;

/** Cap per-window history; at one sample/min this is half a day. */
const MAX_SAMPLES = 720;

/** Per-window sampling policy: how far back the slope looks, and the minimum
 * history span before showing a pace at all. The weekly window moves in ~1%
 * integer steps, so a short lookback would only ever see 0 or a spike. */
const WINDOWS = {
  fiveHour: { windowMs: 5 * HOUR_MS, lookbackMs: 30 * 60_000, minSpanMs: 5 * 60_000 },
  sevenDay: { windowMs: 7 * 24 * HOUR_MS, lookbackMs: 6 * HOUR_MS, minSpanMs: 30 * 60_000 }
} as const;

export type PaceWindow = keyof typeof WINDOWS;

/**
 * Endpoint slope over the samples inside the lookback: %/hour plus the
 * projected time utilization reaches 100% at that pace. Null while the
 * history is too thin to mean anything; rate 0 (idle or declining) carries
 * no projection.
 */
export function computePace(samples: PaceSample[], opts: PaceOpts): Pace | null {
  const recent = samples.filter((s) => s.t >= opts.now - opts.lookbackMs);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.t - first.t;
  if (span < opts.minSpanMs) return null;
  const rate = ((last.utilization - first.utilization) / span) * HOUR_MS;
  if (rate <= 0) return { ratePerHour: 0, projectedExhaustAt: null };
  const msLeft = ((100 - last.utilization) / rate) * HOUR_MS;
  return { ratePerHour: rate, projectedExhaustAt: new Date(opts.now + msLeft).toISOString() };
}

/**
 * Drop samples that belong to a previous window: anything older than the
 * window anchor (resetsAt − window length). No/unparseable resetsAt keeps
 * everything — the utilization-drop check in recordAndPace still guards it.
 */
export function prunedSamples(
  samples: PaceSample[],
  resetsAt: string | null,
  windowMs: number
): PaceSample[] {
  if (!resetsAt) return samples;
  const end = Date.parse(resetsAt);
  if (Number.isNaN(end)) return samples;
  const start = end - windowMs;
  return samples.filter((s) => s.t >= start);
}

// ── RAM-only per-window sample store ──
const store = new Map<PaceWindow, PaceSample[]>();

/** Test hook: forget all history. */
export function resetPaceStore(): void {
  store.clear();
}

/**
 * Record one fetched utilization sample for a window and return the RateLimit
 * with pace fields attached. A utilization drop means the window reset — the
 * old history would poison the slope, so it's discarded.
 */
export function recordAndPace(win: PaceWindow, rl: RateLimit, now = Date.now()): RateLimit {
  if (rl.utilization == null) return { ...rl, ratePerHour: null, projectedExhaustAt: null };
  const cfg = WINDOWS[win];
  let samples = store.get(win) ?? [];
  const last = samples[samples.length - 1];
  if (last && rl.utilization < last.utilization - 0.5) samples = [];
  samples.push({ t: now, utilization: rl.utilization });
  samples = prunedSamples(samples, rl.resetsAt, cfg.windowMs);
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
  store.set(win, samples);
  const pace = computePace(samples, { lookbackMs: cfg.lookbackMs, minSpanMs: cfg.minSpanMs, now });
  return {
    ...rl,
    ratePerHour: pace ? pace.ratePerHour : null,
    projectedExhaustAt: pace ? pace.projectedExhaustAt : null
  };
}
