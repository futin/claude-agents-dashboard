/** `GET /api/sessions/:id` — the working session's subagents: one still running, two done. Newest first. */
import type { SessionDetail } from '../../../shared/types.js';

import { MIN, SEC, agoIso } from './epoch.js';
import { SESSION_IDS } from './sessions.js';

export const sessionDetail: SessionDetail = {
  id: SESSION_IDS.working,
  agents: [
    {
      id: 'toolu_01Running0000000000000003',
      type: 'general-purpose',
      description: 'Write limiter tests',
      status: 'running',
      startedAt: agoIso(50 * SEC),
      endedAt: null,
      durationMs: null,
      tokens: null,
      agentId: 'a3c4e5f6a7b8c9d0',
      toolUses: null
    },
    {
      id: 'toolu_01Done00000000000000000002',
      type: 'Explore',
      description: 'Find existing middleware',
      status: 'done',
      startedAt: agoIso(5 * MIN + 30 * SEC),
      endedAt: agoIso(4 * MIN + 10 * SEC),
      durationMs: 80 * SEC,
      tokens: 38_400,
      agentId: 'b1d2e3f4a5b6c7d8',
      toolUses: 14
    },
    {
      id: 'toolu_01Done00000000000000000001',
      type: 'Plan',
      description: 'Sketch the limiter design',
      status: 'done',
      startedAt: agoIso(5 * MIN + 50 * SEC),
      endedAt: agoIso(5 * MIN + 35 * SEC),
      durationMs: 15 * SEC,
      tokens: 12_900,
      agentId: 'c9e8d7c6b5a4f3e2',
      toolUses: 3
    }
  ],
  running: 1,
  finished: 2
};
