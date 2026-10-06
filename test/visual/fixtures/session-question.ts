/** `GET /api/sessions/:id/question` — the "nothing pending" answer: no held AskUserQuestion wait, so no panel opens. */
import type { SessionQuestion } from '../../../shared/types.js';

import { SESSION_IDS } from './sessions.js';

export const sessionQuestion: SessionQuestion = { id: SESSION_IDS.working, pending: null };
