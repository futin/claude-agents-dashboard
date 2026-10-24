/** `GET /api/sessions/:id/pr` — an open PR with one check still running and a review asked for, so the card shows its pill, every row and the bar. */
import type { SessionPrResponse } from '../../../shared/types.js';

import { SESSION_IDS } from './sessions.js';

export const sessionPr: SessionPrResponse = {
  id: SESSION_IDS.working,
  pr: {
    url: 'https://github.com/aurora-labs/orders/pull/304',
    number: 304,
    repo: 'aurora-labs/orders',
    title: 'feat(orders): per-tenant rate limits on the checkout API',
    live: {
      state: 'open',
      title: 'feat(orders): per-tenant rate limits on the checkout API',
      head: 'feat/orders-rate-limit',
      base: 'main',
      checks: { passed: 3, failed: 0, running: 1, total: 4 },
      review: 'required',
      merge: 'clean',
      endedAt: null
    },
    unavailable: null
  }
};
