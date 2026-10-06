/** `GET /api/usage/rates` — three models with a 17-day token-value strip each, one stable, one drifting, one thin. */
import type { ModelDayRate, ModelRateRow, ModelRateVerdict, UsageCoverage, UsageRatesResponse } from '../../../shared/types.js';

import { DAY, EPOCH, agoIso } from './epoch.js';

const HORIZON = 17;
const round = (n: number): number => Math.round(n);

function daily(base: number, drift: number, preLedger: number): ModelDayRate[] {
  return Array.from({ length: HORIZON }, (_, i) => {
    const ms = EPOCH - (HORIZON - 1 - i) * DAY;
    const date = new Date(ms).toISOString().slice(0, 10);
    const weekend = [0, 6].includes(new Date(ms).getUTCDay());
    if (i < preLedger) return { date, weightedPerPct: null, rawPerPct: null, intervals: 0, utilSum: 0, deviationPct: null, state: 'pre-ledger' };
    if (weekend && i % 2 === 0) return { date, weightedPerPct: null, rawPerPct: null, intervals: 0, utilSum: 0, deviationPct: null, state: 'none' };
    const wobble = (((i * 7) % 9) - 4) / 100;
    const late = i >= HORIZON - 5 ? drift : 0;
    const weighted = round(base * (1 + wobble + late));
    const thin = weekend;
    return {
      date,
      weightedPerPct: weighted,
      rawPerPct: round(weighted * 2.4),
      intervals: thin ? 2 : 6 + (i % 5),
      utilSum: thin ? 1.5 : 9 + (i % 4) * 2,
      deviationPct: Math.round(((weighted - base) / base) * 1000) / 10,
      state: thin ? 'thin' : 'rated'
    };
  });
}

function row(model: string, base: number, drift: number, verdict: ModelRateVerdict, preLedger: number, intervals: number): ModelRateRow {
  const current = round(base * (1 + drift));
  const thin = verdict === 'thin';
  return {
    model,
    rawPerPct: thin ? null : round(current * 2.4),
    weightedPerPct: thin ? null : current,
    baselineRawPerPct: thin ? null : round(base * 2.4),
    baselineWeightedPerPct: thin ? null : base,
    deviationPct: thin ? null : Math.round(drift * 1000) / 10,
    mixAdjustedDeviationPct: thin ? null : Math.round(drift * 900) / 10,
    verdict,
    surfaces: [
      { surface: 'interactive', weightedPerPct: thin ? null : current, baselineWeightedPerPct: thin ? null : base, utilSum: intervals * 1.4 },
      { surface: 'headless', weightedPerPct: thin ? null : round(current / 1.8), baselineWeightedPerPct: null, utilSum: intervals * 0.3 }
    ],
    intervals,
    utilSum: intervals * 1.7,
    days: thin ? 2 : 9,
    baselineDays: thin ? 0 : 7,
    pctPerMWeighted: thin ? null : Math.round((1_000_000 / current) * 0.8 * 100) / 100,
    pctPerRequest: thin ? null : 0.004,
    splitVerdict: thin ? 'thin' : 'fitted',
    fittedWeightedPerPct: thin ? null : round(current * 1.06),
    fitVerdict: thin ? 'thin' : 'fitted',
    fitDeviationPct: thin ? null : 6,
    weekly: {
      weightedPerPct: thin ? null : current * 9,
      rawPerPct: thin ? null : round(current * 9 * 2.4),
      fittedWeightedPerPct: thin ? null : round(current * 9.4),
      verdict: thin ? 'thin' : 'fitted',
      fitVerdict: thin ? 'thin' : 'fitted',
      intervals: thin ? 0 : Math.round(intervals / 4),
      utilSum: thin ? 0 : 38,
      days: thin ? 0 : 6
    },
    daily: thin ? daily(base, 0, HORIZON - 3) : daily(base, drift, preLedger)
  };
}

function coverage(scale: number): UsageCoverage {
  const [priced, mixed, external, preLedger, missing, partial] = [300, 60, 30, 20, 6, 4].map(n => n * scale);
  return {
    movedPct: priced + mixed + external + preLedger + missing + partial,
    pricedPct: priced,
    mixedPct: mixed,
    externalPct: external,
    preLedgerPct: preLedger,
    missingPct: missing,
    partialPct: partial,
    recorderBreakHours: 3.5,
    startProvable: true
  };
}

export const usageRates: UsageRatesResponse = {
  generatedAt: agoIso(0),
  recording: true,
  models: [
    row('claude-opus-4-6', 18_400, 0.02, 'stable', 2, 84),
    row('claude-sonnet-4-5-20250929', 52_000, -0.21, 'drift', 4, 41),
    row('claude-haiku-4-5-20251001', 160_000, 0, 'thin', 0, 3)
  ],
  externalSharePct: 7.1,
  coverage: coverage(1),
  weeklyRecorded: true,
  weeklyCoverage: coverage(0.25),
  weeklyExternalSharePct: 5.4,
  boost: {
    verdict: 'none',
    reason: 'flat',
    model: 'claude-opus-4-6',
    ratio: 1.02,
    rawRatio: 1.01,
    days: 9,
    since: null,
    peakStartHourEt: 5,
    peakEndHourEt: 11,
    hours: [],
    weekend: { verdict: 'inconclusive', reason: 'thin-evidence', ratio: 1.1, rawRatio: 1.08, days: 2, since: null, controlDays: 8 }
  }
};
