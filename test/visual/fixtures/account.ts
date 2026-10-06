/** `GET /api/account` — an invented profile plus the live limits the header bars draw. */
import type { AccountResponse } from '../../../shared/types.js';

import { EPOCH, HOUR } from './epoch.js';
import { FIVE_RESETS_MS, FIVE_UTIL, WEEK_RATE, WEEK_RESETS_MS, WEEK_UTIL, forecastWalk } from './usage-model.js';

const iso = (ms: number): string => new Date(ms).toISOString();
const { walk, dutyCycle } = forecastWalk();
/** The same crossing the forecast walk reports, so the header and the Usage page agree. */
const crossing = walk.find(s => s.cum >= 100);

export const account: AccountResponse = {
  profile: {
    name: 'Sam Example',
    email: 'sam@example.com',
    organization: 'Example Labs',
    plan: 'Max 5×',
    seat: '',
    extraUsage: false
  },
  usage: {
    fiveHour: {
      utilization: FIVE_UTIL,
      resetsAt: iso(FIVE_RESETS_MS),
      ratePerHour: 12,
      projectedExhaustAt: iso(EPOCH + Math.round(((100 - FIVE_UTIL) / 12) * HOUR)),
      pessimisticExhaustAt: iso(EPOCH + Math.round(((100 - FIVE_UTIL) / 12) * HOUR)),
      dutyCycle: null,
      forecastConfidence: 'none'
    },
    sevenDay: {
      utilization: WEEK_UTIL,
      resetsAt: iso(WEEK_RESETS_MS),
      ratePerHour: WEEK_RATE,
      projectedExhaustAt: crossing ? crossing.t : null,
      pessimisticExhaustAt: iso(EPOCH + Math.round(((100 - WEEK_UTIL) / WEEK_RATE) * HOUR)),
      dutyCycle,
      forecastConfidence: 'ok'
    }
  },
  usageStatus: 'ok'
};
