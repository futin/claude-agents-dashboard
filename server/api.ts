/**
 * api.ts — the `/api/sessions` endpoint. Scans sessions and writes JSON,
 * with a safe empty-snapshot fallback if the scan throws.
 */

import type { ServerResponse } from 'node:http';

import { scanSessions } from './lib/scan.js';
import type { Config } from './lib/config.js';
import type { SessionsResponse } from '../shared/types.js';

export function serveSessions(config: Config, res: ServerResponse): void {
  let data: SessionsResponse;
  try {
    data = scanSessions(config);
  } catch (e) {
    console.error('[dashboard] scan failed:', (e as Error).message);
    data = {
      error: true,
      generatedAt: new Date().toISOString(),
      activeWindowMin: config.activeWindowMin,
      maxSessions: config.maxSessions,
      runningClaudeProcs: null,
      sessions: [],
      totals: { shown: 0, active: 0 }
    };
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
