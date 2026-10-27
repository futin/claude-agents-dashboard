/**
 * usage-shape.ts — the pure halves of `GET /api/usage/profile` and `GET /api/usage/rates`: given what the routes read off disk, the exact body each one
 * sends. No clock, no disk, no settings read, so every calendar edge and honesty rule is testable without a server. The routes in `api.ts` keep the reads
 * and call in here.
 */

import type { ProfileState, UsageSample } from './usage-history.js';
import { deriveProfile } from './usage-history.js';
import type { LedgerLine } from './usage-ledger.js';
import {
  BASELINE_MS, WEEKLY_FLOORS, coverageBreakdown, currentRange, dailyRates, driftRow, externalShare,
  fitDeviation, fitRates, fitSplits, joinIntervals, joinWeeklyIntervals, ledgerBreakMs,
  poolRate, rateFor
} from './usage-rate.js';
import { detectBoost, emptyBoost } from './usage-boost.js';
import { HOURS_PER_WEEK, confidenceOf, walkForward } from './usage-forecast.js';
import type {
  ModelRateRow, RateLimit, UsageCoverage, UsageProfileCell, UsageProfileResponse, UsageRatesResponse
} from '../../shared/types.js';

/** An empty grid, for the fail-open path and for a never-recorded profile. */
export function blankCells(): UsageProfileCell[] {
  return Array.from({ length: HOURS_PER_WEEK }, (_, hourOfWeek) => ({
    hourOfWeek, weight: null, observedMin: 0, staleWeeks: 0
  }));
}

/**
 * Shape one `GET /api/usage/profile` body. Pure — no clock, no disk, no
 * timezone — so every calendar edge is testable (test/usage-profile-api.test.ts).
 *
 * The walk is re-run here with the *same* implementation that produced the
 * projection in `usage-pace.ts`, so the inspector can never drift from what it
 * claims to disclose. And it deliberately carries **no raw samples and no file
 * paths** — cells and the walk only, the same posture as `NTFY_TOPIC` never
 * leaving the server.
 *
 * With recording off the learned cells are still returned (they are real
 * evidence, and this endpoint exists to disclose it) but `confidence` is `none`
 * and the walk is empty: nothing is feeding the forecast, so claiming otherwise
 * would be the dishonest option. The view leads with `recording: false`.
 */
export function shapeUsageProfile(opts: {
  recording: boolean;
  state: ProfileState;
  weekly: RateLimit | null;
  nowMs: number;
  offsetMinutes: number;
}): UsageProfileResponse {
  const { recording, state, weekly, nowMs, offsetMinutes } = opts;
  const profile = deriveProfile(state);

  const cells: UsageProfileCell[] = state.buckets.map((b, hourOfWeek) => {
    const stamp = b.weekStamp;
    return {
      hourOfWeek,
      weight: profile.weights[hourOfWeek],
      observedMin: b.lifetimeObservedMin,
      // Observed weeks after the one this bucket last saw traffic in — the same
      // count the fold's decay applies. `observedWeeks` never holds a future
      // week, so "after the stamp" already means "up to now".
      staleWeeks: stamp === null ? 0 : state.observedWeeks.filter((w) => w > stamp).length
    };
  });

  const rate = weekly?.ratePerHour ?? null;
  const resetsAtMs = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : Number.NaN;
  // The window's own two facts, reported whether or not a walk can be run:
  // the forecast page states them before any projection, so they follow the
  // *limits* being readable, not the profile being usable.
  const utilizationPct = typeof weekly?.utilization === 'number' ? weekly.utilization : null;
  const resetsAt = Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null;
  // Ordered, not combined: the strip states *which* precondition is missing, so
  // "there is nothing to draw" reads as a state rather than as a broken panel.
  // Recording first — with it off nothing else has been measured either.
  const absent: UsageProfileResponse['walkAbsent'] =
    !recording ? 'recording-off'
      : rate == null || rate <= 0 ? 'no-rate'
        : weekly?.utilization == null || !Number.isFinite(resetsAtMs) ? 'no-window'
          : null;

  if (absent !== null) {
    return {
      cells,
      globalMean: profile.globalMean,
      confidence: recording ? confidenceOf(profile) : 'none',
      recording,
      walk: [],
      exhaustAt: null,
      walkAbsent: absent,
      utilizationPct,
      resetsAt,
      // No walk, so no slices to weigh — null rather than 0, which would read
      // as a measured "never active".
      dutyCycle: null
    };
  }

  const walked = walkForward({
    nowMs,
    utilization: weekly!.utilization as number,
    activeRatePerHour: rate as number,
    profile,
    resetsAtMs,
    offsetMinutes
  });
  return {
    cells,
    globalMean: profile.globalMean,
    confidence: confidenceOf(profile),
    recording,
    walk: walked.steps.map((x) => ({
      t: new Date(x.tMs).toISOString(),
      gain: x.gain,
      cum: x.cum,
      weight: x.weight,
      learned: x.learned
    })),
    exhaustAt: walked.exhaustAtMs == null ? null : new Date(walked.exhaustAtMs).toISOString(),
    // A walked window has nothing absent to report; the field is the negative
    // space of `walk`, so a non-empty walk always pairs with null.
    walkAbsent: null,
    utilizationPct,
    resetsAt,
    dutyCycle: walked.dutyCycle
  };
}

/**
 * An honest empty body — no ledger yet, recording off, or a failed fit.
 *
 * `coverage` is present and zeroed rather than absent: the counters have no
 * nulls, so "nothing measured" is a row of measured zeros, and an optional
 * field here would push a null check into the card for a state that cannot
 * happen. `startProvable` is false because nothing was read to prove it.
 */
function zeroCoverage(): UsageCoverage {
  return {
    movedPct: 0, pricedPct: 0, mixedPct: 0, externalPct: 0,
    preLedgerPct: 0, missingPct: 0, partialPct: 0,
    recorderBreakHours: 0, startProvable: false
  };
}

/** The rates body with nothing measured: recording off, and the route's fail-open path. */
export function emptyRates(nowMs: number, recording: boolean, error?: true): UsageRatesResponse {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    recording,
    models: [],
    externalSharePct: null,
    coverage: zeroCoverage(),
    // `weeklyRecorded` is false because nothing was read to say otherwise — the
    // same reasoning as `startProvable`, and not a claim that the record is old.
    weeklyRecorded: false,
    weeklyCoverage: zeroCoverage(),
    weeklyExternalSharePct: null,
    boost: emptyBoost(),
    ...(error ? { error: true } : {})
  };
}

/**
 * Shape one `GET /api/usage/rates` body. Pure — no clock, no disk — so the
 * arithmetic and every honesty rule are testable (test/api-usage-rates.test.ts).
 *
 * One row per model that either owns an attributable interval **or** is
 * identified by the one-term joint fit, richest evidence first: the model you
 * actually use should not sit under a model you tried once. A model with
 * neither still gets no row at all — there is nothing to say about it yet, and
 * a row of nulls reads as a broken fit rather than as an absence of evidence.
 *
 * The fitted-only case is the one the second half of that rule exists for: a
 * model used only as a subagent beside a driver model never holds `DOMINANCE`
 * of a window, so the pooled rate has nothing for it and the card used to omit
 * it entirely. Its row's pooled numbers are legitimately all null with a `thin`
 * verdict and zeroed counters — honest, and not special-cased.
 */
export function shapeUsageRates(opts: {
  recording: boolean;
  samples: UsageSample[];
  ledger: LedgerLine[];
  nowMs: number;
  /**
   * When recording provably began, or null when the ledger cannot prove it.
   * A parameter rather than a read, so this stays pure.
   */
  ledgerStartMs: number | null;
}): UsageRatesResponse {
  const { recording, samples, ledger, nowMs, ledgerStartMs: startMs } = opts;
  if (!recording) return emptyRates(nowMs, false);

  const intervals = joinIntervals(samples, ledger, startMs);
  const models = new Set<string>();
  for (const interval of intervals) {
    if (typeof interval.kind === 'object') models.add(interval.kind.model);
  }

  // Both joint fits run over the same current window the pooled rows report,
  // so a row's three numbers never describe different spans.
  const cur = currentRange(nowMs);
  const splits = fitSplits(intervals, cur.sinceMs, cur.untilMs);
  const fitted = fitRates(intervals, cur.sinceMs, cur.untilMs);
  for (const model of fitted.keys()) models.add(model);

  // The weekly set, built once. Paired tick to tick rather than sample to
  // sample — see `joinWeeklyIntervals`, where the 6.5×–10.4× underestimate that
  // consecutive pairing produces is measured. Fitted over the *same* 3-day
  // window as everything above: this card refuses to put two figures spanning
  // different windows side by side.
  const weeklyIntervals = joinWeeklyIntervals(samples, ledger, startMs);
  const weeklyFitted = fitRates(weeklyIntervals, cur.sinceMs, cur.untilMs, WEEKLY_FLOORS);
  // A model priced only weekly still gets a row, exactly as a fitted-only model
  // already does.
  for (const interval of weeklyIntervals) {
    if (typeof interval.kind === 'object') models.add(interval.kind.model);
  }
  for (const model of weeklyFitted.keys()) models.add(model);

  const rows: ModelRateRow[] = [...models]
    .map((model) => {
      const split = splits.get(model);
      const fit = fitted.get(model);
      const drift = driftRow(intervals, model, nowMs);
      const weeklyPooled = rateFor(
        weeklyIntervals, model, cur.sinceMs, cur.untilMs, WEEKLY_FLOORS
      );
      const weeklyFit = weeklyFitted.get(model);
      // The evidence survives the refusal, as the 5-hour row's already does:
      // "10 windows over 2 days, still thin" and "nothing at all" are different
      // statements and the card says which.
      const weeklyEvidence = poolRate(weeklyIntervals, model, cur.sinceMs, cur.untilMs);
      return {
        ...drift,
        pctPerMWeighted: split?.pctPerMWeighted ?? null,
        pctPerRequest: split?.pctPerRequest ?? null,
        splitVerdict: split === undefined ? ('thin' as const) : ('fitted' as const),
        fittedWeightedPerPct: fit?.weightedPerPct ?? null,
        fitVerdict: fit === undefined ? ('thin' as const) : ('fitted' as const),
        // Against the pooled rate the row already publishes, so the number the
        // card compares is the number the card shows.
        fitDeviationPct: fitDeviation(fit?.weightedPerPct ?? null, drift.weightedPerPct),
        weekly: {
          weightedPerPct: weeklyPooled?.weightedPerPct ?? null,
          rawPerPct: weeklyPooled?.rawPerPct ?? null,
          fittedWeightedPerPct: weeklyFit?.weightedPerPct ?? null,
          verdict: weeklyPooled === null ? ('thin' as const) : ('fitted' as const),
          fitVerdict: weeklyFit === undefined ? ('thin' as const) : ('fitted' as const),
          intervals: weeklyEvidence?.intervals ?? 0,
          utilSum: weeklyEvidence?.utilSum ?? 0,
          days: weeklyEvidence?.days ?? 0
        },
        // The days the two figures above were pooled from, judged against the
        // same baseline the badge is — so the cells and the verdict cannot
        // disagree about what a day was compared to.
        daily: dailyRates(intervals, model, nowMs, startMs, drift.baselineWeightedPerPct)
      };
    })
    // On the **5-hour** `utilSum`, unchanged: a weekly-only model sorts last,
    // as a fitted-only model already does.
    .sort((a, b) => b.utilSum - a.utilSum || a.model.localeCompare(b.model));

  // Over the whole fitted horizon, not just the trailing window: it describes
  // how much of everything behind these numbers had to be thrown away.
  const share = externalShare(intervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);

  // Deliberately the same horizon as `externalSharePct` above: two disclosure
  // figures on one card that quietly spanned different windows would be a
  // defect, not a nuance.
  const buckets = coverageBreakdown(intervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);
  const breakMs = ledgerBreakMs(ledger, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);

  // Same horizon again for the weekly disclosure figures, for the same reason.
  const weeklyBuckets = coverageBreakdown(
    weeklyIntervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY
  );
  const weeklyShare = externalShare(
    weeklyIntervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY
  );

  return {
    generatedAt: new Date(nowMs).toISOString(),
    recording: true,
    models: rows,
    externalSharePct: share === null ? null : share * 100,
    coverage: {
      movedPct: buckets.moved,
      pricedPct: buckets.priced,
      mixedPct: buckets.mixed,
      externalPct: buckets.external,
      preLedgerPct: buckets.preLedger,
      missingPct: buckets.gap,
      partialPct: buckets.partial,
      recorderBreakHours: breakMs / 3_600_000,
      startProvable: startMs !== null
    },
    // Read off the samples, not the intervals: a record that carries weekly
    // readings whose counter simply never moved yields no intervals at all, and
    // that is a different state from a record written before the field existed.
    weeklyRecorded: samples.some((sample) => sample.week !== undefined),
    weeklyCoverage: {
      movedPct: weeklyBuckets.moved,
      pricedPct: weeklyBuckets.priced,
      mixedPct: weeklyBuckets.mixed,
      externalPct: weeklyBuckets.external,
      preLedgerPct: weeklyBuckets.preLedger,
      missingPct: weeklyBuckets.gap,
      partialPct: weeklyBuckets.partial,
      recorderBreakHours: breakMs / 3_600_000,
      startProvable: startMs !== null
    },
    weeklyExternalSharePct: weeklyShare === null ? null : weeklyShare * 100,
    // Off the 5-hour intervals already built above — no second join, no second read.
    boost: detectBoost(intervals, nowMs)
  };
}
