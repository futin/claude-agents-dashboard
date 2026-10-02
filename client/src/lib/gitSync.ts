/**
 * gitSync.ts — the rules behind Management › Git's Sync button (git-stats spec §9): which repos get one, the `POST /api/spawn` body it sends, what a
 * remembered run is doing now, and every string the button and its note show. Pure, so `test/git-sync-client.test.ts` drives it without React.
 */

import type { HealthResponse, RepoGitStats, Session, SessionsResponse, SpawnRequest } from '../../../shared/types';
import type { Settings } from './settings';
import { NAME_CAP } from './spawnOptions';

export type OkRepo = Extract<RepoGitStats, { state: 'ok' }>;

/** The plugin's skill, by name: the client never imports plugin code. */
export const GIT_SYNC_PROMPT = '/claude-agents-dashboard:git-sync';
export const SYNC_RUNS_KEY = 'management.syncRuns';
/** The server's `SCAN_CAPS.limit`: the gated sessions poll asks for every row it may, so a parked sync rarely falls off the list. */
export const SYNC_SCAN_LIMIT = 50;
/** A run nobody has seen for this long after launch is taken as over. */
export const SYNC_UNSEEN_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A run whose session row was never seen is taken as over this soon after launch: its launch most likely failed while no tab watched, and the server forgets
 * a failed launch after 5 min (`FAIL_TTL_MS`), so waiting the full day would hold a dead pill for 24h.
 */
export const SYNC_NEVER_SEEN_TTL_MS = 10 * 60 * 1000;

export const SYNC_NEEDS_TOKEN = 'Sync needs the Answer token — set it under Settings › Local › Connection.';

/** One launched sync, remembered per device under its repo's toplevel. */
export interface SyncRun {
  sessionId: string;
  dirName: string;
  /** `repo.name`, for the notes — not the session name. */
  name: string;
  launchedAtMs: number;
  /** Its session row has shown in a payload at least once; until then absence ends it after `SYNC_NEVER_SEEN_TTL_MS`, not the full day. */
  seen: boolean;
}

export type SyncRuns = Record<string, SyncRun>;

export type SyncPhase =
  | { kind: 'launching' }
  | { kind: 'running'; session: Session }
  | { kind: 'unseen' }
  | { kind: 'ended' }
  | { kind: 'failed'; error: string | null };

type SyncSettings = Pick<Settings, 'syncModel' | 'syncEffort'>;
/** The two launch fields the host decides, read off `/api/health`; either may be missing before it answers or on an older server. */
export type SyncHost = Partial<Pick<HealthResponse, 'syncPermissionMode' | 'remoteAnswer'>>;

/** git-sync refuses a repo it cannot read or one with no origin to sync against. */
export function canSync(repo: RepoGitStats): repo is OkRepo {
  return repo.state === 'ok' && repo.hasOrigin;
}

/** `git-sync <repo>`, made to pass the server's `NAME_RE` and `NAME_CAP`, which drop a bad name silently. */
export function syncSessionName(repoName: string): string {
  return `git-sync ${repoName.replace(/[^A-Za-z0-9 ._-]/g, '-')}`.slice(0, NAME_CAP);
}

/**
 * The launch body. Permission mode is the host's `SYNC_PERMISSION_MODE`, already clamped to its ceiling by the server; unknown, it is left out and the
 * server's own default applies. Remote control follows Remote answers, and is off until health says otherwise. Always one-shot: the run closes when done,
 * and a follow-up goes through Resume.
 */
export function syncRequest(repo: OkRepo, s: SyncSettings, host: SyncHost): SpawnRequest {
  const req: SpawnRequest = {
    project: repo.dirName,
    prompt: GIT_SYNC_PROMPT,
    name: syncSessionName(repo.name),
    remoteControl: host.remoteAnswer === true,
    oneShot: true,
  };
  if (host.syncPermissionMode) req.permissionMode = host.syncPermissionMode;
  if (s.syncModel) req.model = s.syncModel;
  if (s.syncEffort) req.effort = s.syncEffort;
  return req;
}

/**
 * What `run` is doing in `data`. A row that is not in the payload is not proof of an end: the scan caps its rows by recency, and a sync parked on its
 * question writes nothing, so absence only ends a run after `SYNC_UNSEEN_TTL_MS` — or `SYNC_NEVER_SEEN_TTL_MS` for a run whose row never showed.
 */
export function syncPhase(run: SyncRun, data: SessionsResponse | null, nowMs: number): SyncPhase {
  if (!data) return { kind: 'unseen' };
  const launch = data.launching?.find(l => l.sessionId === run.sessionId);
  if (launch) return launch.state === 'failed' ? { kind: 'failed', error: launch.error ?? null } : { kind: 'launching' };
  const row = data.sessions.find(s => s.id === run.sessionId);
  if (row) return row.status === 'working' || row.status === 'question' ? { kind: 'running', session: row } : { kind: 'ended' };
  return nowMs - run.launchedAtMs < (run.seen ? SYNC_UNSEEN_TTL_MS : SYNC_NEVER_SEEN_TTL_MS) ? { kind: 'unseen' } : { kind: 'ended' };
}

export function runFor(runs: SyncRuns, repo: RepoGitStats): SyncRun | null {
  return repo.state === 'ok' ? runs[repo.toplevel] ?? null : null;
}

/** The stored map as it may come back from `localStorage`: anything malformed is dropped, never thrown. */
export function parseSyncRuns(raw: unknown): SyncRuns {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SyncRuns = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.sessionId !== 'string' || typeof r.dirName !== 'string' || typeof r.name !== 'string') continue;
    if (typeof r.launchedAtMs !== 'number' || !Number.isFinite(r.launchedAtMs)) continue;
    out[key] = { sessionId: r.sessionId, dirName: r.dirName, name: r.name, launchedAtMs: r.launchedAtMs, seen: r.seen === true };
  }
  return out;
}

export function syncButtonText(phase: SyncPhase | null, pending: boolean): string {
  if (pending) return 'Starting…';
  if (!phase) return 'Sync';
  // No "· open" suffix: the running key is already tinted and turning, which says it is live and clickable; the disabled states carry the ellipsis.
  if (phase.kind === 'running') return 'Syncing';
  if (phase.kind === 'launching' || phase.kind === 'unseen') return 'Syncing…';
  return 'Sync';
}

export function syncFailedText(name: string, error: string | null): string {
  return error ? `git-sync in ${name} failed to start: ${error}` : `git-sync in ${name} failed to start.`;
}

export function syncLaunchErrorText(name: string, error: string): string {
  return `Sync in ${name} couldn't start: ${error}`;
}
