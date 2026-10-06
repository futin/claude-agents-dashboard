/** `GET /api/sessions/:id/message` — the "nothing pending" answer: no held turn-end reply wait, so no panel opens. */
import type { SessionMessage } from '../../../shared/types.js';

import { SESSION_IDS } from './sessions.js';

export const sessionMessage: SessionMessage = { id: SESSION_IDS.working, pending: null };
