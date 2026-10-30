/** `GET /api/health` — remote answers on, local origin, spawn and the desktop app available, no token required. */
import type { HealthResponse } from '../../../shared/types.js';

import { settings } from './settings.js';

export const health: HealthResponse = {
  ok: true,
  available: true,
  enabled: true,
  remoteAnswer: true,
  persisted: true,
  origin: 'local',
  idleSecs: settings.idleSecs,
  answerSecs: settings.answerSecs,
  tokenRequired: false,
  transcribe: false,
  spawnAvailable: true,
  // The macOS desktop app is installed: the drawer's hand-over button and the launch form's Dashboard | Desktop picker both render.
  desktopAvailable: true,
  spawnMaxPermission: 'auto',
  syncPermissionMode: 'auto'
};
