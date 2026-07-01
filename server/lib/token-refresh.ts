/**
 * token-refresh.ts — recover an expired OAuth token by spawning one headless
 * `claude -p` turn. The CLI refreshes and persists its own credentials; the
 * dashboard never writes them (direct OAuth refresh was rejected — see
 * docs/superpowers/specs/2026-07-01-usage-token-refresh-design.md).
 *
 * The turn runs in a dedicated cwd so the transcript it writes lands under a
 * known project dir, which scan.ts filters out (phantom-session mitigation).
 * Zero runtime deps — Node built-ins only.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPAWN_TIMEOUT_MS = 60_000;

/** cwd for the spawned turn. Exported so scan.ts can filter its transcript. */
export function refreshCwd(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude', 'dashboard-refresh');
}

export interface SpawnResult {
  /** Exit code; null when the process never ran or was killed (ENOENT/timeout). */
  code: number | null;
  error?: string;
}

/** Injectable for tests — the real one execFiles `claude`. */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
) => Promise<SpawnResult>;

const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolve) => {
    // Strip API-key/proxy vars: with them the spawned turn could bill an API
    // key or route to a gateway and exit 0 WITHOUT touching the OAuth creds
    // this refresh exists to renew (same misroute class as the usage endpoint
    // vs ANTHROPIC_BASE_URL — see CLAUDE.md "Usage limits").
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_API_BASE_URL;
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, env }, (err) => {
      if (!err) return resolve({ code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return resolve({ code: null, error: 'claude CLI not found on PATH' });
      if (e.killed) return resolve({ code: null, error: 'claude timed out' });
      resolve({
        code: typeof e.code === 'number' ? e.code : null,
        error: typeof e.code === 'number' ? `claude exited with code ${e.code}` : e.message
      });
    });
    // Close stdin so a prompt-less turn can never sit waiting on the pipe
    // until the 60s timeout.
    child.stdin?.end();
  });

export type RefreshOutcome =
  | { ok: true }
  | { ok: false; httpStatus: 409 | 502; error: string };

let inFlight = false;

/**
 * Spawn one headless `claude -p "ok" --model haiku` so the CLI refreshes its
 * token. Single-flight: a second call while one runs bounces with 409. Costs
 * one (haiku) subscription turn per successful call — only ever user-initiated.
 */
export async function runTokenRefresh(
  spawner: Spawner = defaultSpawner,
  cwd = refreshCwd()
): Promise<RefreshOutcome> {
  if (inFlight) return { ok: false, httpStatus: 409, error: 'refresh already running' };
  inFlight = true;
  try {
    fs.mkdirSync(cwd, { recursive: true });
    const r = await spawner('claude', ['-p', 'ok', '--model', 'haiku'], { cwd, timeout: SPAWN_TIMEOUT_MS });
    if (r.code === 0) return { ok: true };
    return { ok: false, httpStatus: 502, error: r.error || `claude exited with code ${r.code}` };
  } catch (e) {
    return { ok: false, httpStatus: 502, error: (e as Error).message };
  } finally {
    inFlight = false;
  }
}
