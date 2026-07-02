/**
 * api.ts — the `/api/sessions` endpoints. `serveSessions` writes the ranked
 * snapshot; `serveSessionDetail` writes one session's subagent activity. Both
 * fall back to a safe empty payload if the scan throws.
 */

import type { ServerResponse } from 'node:http';

import { scanSessions, listTranscripts, projectsRoot } from './lib/scan.js';
import { readAgentsCached } from './lib/agents-cache.js';
import { getCachedUsageState, forceUsageRefresh } from './lib/usage.js';
import { runTokenRefresh, refreshCwd } from './lib/token-refresh.js';
import type { Spawner } from './lib/token-refresh.js';
import type { UsageState } from './lib/usage.js';
import type { Config } from './lib/config.js';
import type { SessionsResponse, SessionDetail, UsageRefreshResponse } from '../shared/types.js';

/** Session ids are transcript filenames (UUIDs) — restrict to safe chars. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

export function serveSessions(config: Config, res: ServerResponse): void {
  let data: SessionsResponse;
  try {
    data = scanSessions(config, { skipProcScan: config.skipProcScan });
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
  // Account usage (5h + weekly). Synchronous cache read; refresh happens in the
  // background. Fails open to null so it never blocks or breaks the response.
  if (config.showUsage) {
    const u = getCachedUsageState();
    data.usage = u.usage;
    data.usageStatus = u.status;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/**
 * `GET /api/sessions/:id` — the subagents a session launched. First selection
 * reads the full transcript; while the session stays selected, the 3s detail
 * poll goes through the incremental cache and costs O(new bytes) (see
 * agents-cache.ts). Still runs only on selection — never in the list poll.
 * The id is resolved against the enumerated transcript list, never joined into a
 * path directly, so a hostile id can't escape the projects root.
 */
export function serveSessionDetail(id: string, res: ServerResponse): void {
  const fail = (code: number): void => {
    const body: SessionDetail = { id, agents: [], running: 0, finished: 0, error: true };
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!ID_RE.test(id)) return fail(400);

  let detail: SessionDetail;
  try {
    const ref = listTranscripts(projectsRoot()).find(t => t.id === id);
    if (!ref) return fail(404);
    const agents = readAgentsCached(ref.file);
    if (!agents) return fail(404);
    detail = {
      id,
      agents,
      running: agents.filter(a => a.status === 'running').length,
      finished: agents.filter(a => a.status === 'done').length
    };
  } catch (e) {
    console.error('[dashboard] session detail failed:', (e as Error).message);
    return fail(500);
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(detail));
}

/**
 * `POST /api/usage/refresh` — recover from an expired OAuth token. Spawns one
 * headless `claude -p` turn (the CLI refreshes its own creds), then bypasses
 * the usage-cache TTL so the fresh token is used immediately. Single-flight:
 * concurrent requests get 409. Gated by SHOW_USAGE like the bars themselves.
 * `deps` is a test seam (fake spawner / usage fetcher / cwd).
 */
export async function serveUsageRefresh(
  config: Config,
  res: ServerResponse,
  deps: { spawner?: Spawner; cwd?: string; refreshUsage?: () => Promise<UsageState> } = {}
): Promise<void> {
  const send = (code: number, body: UsageRefreshResponse): void => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!config.showUsage) return send(404, { ok: false, error: 'usage disabled' });
  const outcome = await runTokenRefresh(deps.spawner, deps.cwd ?? refreshCwd());
  if (!outcome.ok) return send(outcome.httpStatus, { ok: false, error: outcome.error });
  const state = await (deps.refreshUsage ?? forceUsageRefresh)();
  send(200, { ok: true, usage: state.usage, usageStatus: state.status });
}
