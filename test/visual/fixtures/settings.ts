/** `GET /api/settings` — the server-side settings the Settings page reads (`client/src/hooks/useServerSettings.ts` gates on `idleSecs` being a number). */
import type { ServerSettings } from '../../../shared/types.js';

export const settings: ServerSettings = {
  idleSecs: 120,
  answerSecs: 600,
  recordUsageHistory: true,
  gitFetchSecs: 300,
  trustTailnet: true,
  persisted: true,
  idleOverride: null,
  answerOverride: null,
  notify: {
    enabled: true,
    events: { question: true, stop: false, permission: true, plan: true, 'routine-failed': true, 'tick-capped': false, 'usage-limit': false,
      'usage-reset': false },
    requireRemoteAnswer: true,
    requireAfk: true,
    requireAutoMode: false
  },
  notifyAvailable: true,
  usageAvailable: true,
  staleEnvKeys: []
};
