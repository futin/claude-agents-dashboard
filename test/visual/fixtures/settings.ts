/** `GET /api/settings` — the server-side settings the Settings page reads (`client/src/hooks/useServerSettings.ts` gates on `idleSecs` being a number). */
import type { ServerSettings } from '../../../shared/types.js';

export const settings: ServerSettings = {
  idleSecs: 120,
  answerSecs: 600,
  recordUsageHistory: true,
  gitFetchSecs: 300,
  persisted: true,
  idleOverride: null,
  answerOverride: null,
  notify: {
    enabled: true,
    events: { question: true, stop: false, permission: true, plan: true },
    requireRemoteAnswer: true,
    requireAfk: true,
    requireAutoMode: false
  },
  notifyAvailable: true,
  staleEnvKeys: []
};
