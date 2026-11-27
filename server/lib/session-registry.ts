/**
 * session-registry.ts — whether a session's own `claude` process is alive, for `SessionDetail.parentLive` (#588 D3).
 *
 * The process probe's argv read (`ProcProbe.liveSessionIds`) only knows ids passed as `--session-id`/`--resume`, so a plain `claude` started in a terminal
 * would read dead. Claude Code also writes a registry, `~/.claude/sessions/<pid>.json` (`{ pid, sessionId, cwd, kind, status, … }`); an entry whose `pid`
 * is a live `claude` pid proves its `sessionId` live. A disk read — no new outbound kind. The directory also holds `<pid>.<hash>.key` files, which are
 * never opened.
 */

import fs from 'node:fs';
import path from 'node:path';

import { claudeHome } from './paths.js';
import type { ProcProbe } from './scan.js';

/**
 * sessionId → pids, from every parsable `*.json` entry carrying a string `sessionId` and a numeric `pid`. null when the directory cannot be read, ENOENT
 * included: a Claude Code build that writes no registry cannot prove a session absent.
 */
export function readSessionRegistry(homeDir?: string): Map<string, string[]> | null {
  const dir = path.join(claudeHome(homeDir), 'sessions');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const out = new Map<string, string[]>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let rec: any;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!rec || typeof rec.sessionId !== 'string' || typeof rec.pid !== 'number' || !Number.isFinite(rec.pid)) continue;
    const pids = out.get(rec.sessionId);
    if (pids) pids.push(String(rec.pid));
    else out.set(rec.sessionId, [String(rec.pid)]);
  }
  return out;
}

/**
 * `true` when the argv read names `id` or a registry pid for `id` is a live `claude` pid; `false` only when every source answered and none matched;
 * otherwise `null`. Pure.
 */
export function parentLiveOf(id: string, probe: ProcProbe | null, registry: Map<string, string[]> | null): boolean | null {
  if (probe?.liveSessionIds?.has(id)) return true;
  const pids = registry?.get(id);
  if (pids && probe?.claudePids && pids.some(p => probe.claudePids!.has(p))) return true;
  if (!probe || !probe.liveSessionIds || !probe.claudePids || !registry) return null;
  return false;
}
