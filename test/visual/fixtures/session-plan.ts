/** `GET /api/sessions/:id/plan` — the "nothing pending" answer: no held ExitPlanMode wait, so no panel opens. */
import type { SessionPlan } from '../../../shared/types.js';

import { SESSION_IDS } from './sessions.js';

export const sessionPlan: SessionPlan = { id: SESSION_IDS.working, pending: null };
