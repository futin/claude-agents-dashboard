/** `GET /api/usage/profile` — a learned weekday-office-hours profile and the walk to the weekly reset. */
import type { UsageProfileResponse } from '../../../shared/types.js';

import { GLOBAL_MEAN, WEEK_RESETS_MS, WEEK_UTIL, forecastWalk, weightFor } from './usage-model.js';

const { walk, dutyCycle } = forecastWalk();
const crossing = walk.find(s => s.cum >= 100);

export const usageProfile: UsageProfileResponse = {
  cells: Array.from({ length: 168 }, (_, hourOfWeek) => {
    const weight = weightFor(hourOfWeek);
    return { hourOfWeek, weight, observedMin: weight === null ? 35 : 180, staleWeeks: hourOfWeek % 23 === 0 ? 1 : 0 };
  }),
  globalMean: GLOBAL_MEAN,
  confidence: 'ok',
  recording: true,
  walk,
  exhaustAt: crossing ? crossing.t : null,
  walkAbsent: null,
  utilizationPct: WEEK_UTIL,
  resetsAt: new Date(WEEK_RESETS_MS).toISOString(),
  dutyCycle
};
