/**
 * api.ts — the `/api/sessions` endpoints. `serveSessions` writes the ranked
 * snapshot; `serveSessionDetail` writes one session's subagent activity. Both
 * fall back to a safe empty payload if the scan throws.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { scanSessions, listTranscripts, projectsRoot } from './lib/scan.js';
import { readAgentsCached } from './lib/agents-cache.js';
import { getCachedUsageState } from './lib/usage.js';
import {
  claudeHome, collectServablePaths, listRecentProjects, readGlobalScope,
  readProjectScope, readServableFile, resolveProject
} from './lib/management.js';
import { listReports, reviewStatus } from './lib/analytics.js';
import {
  CHAT_PAGE_MESSAGES, DEFAULT_CAPS, NO_CAPS, readChatAfter, readChatBefore, readChatTail
} from './lib/chat.js';
import {
  answer as answerPending, cancel as cancelPending, clampTimeout,
  dismissAll, getPending, pendingSessionIds, register, sanitizeQuestions
} from './lib/pending.js';
import {
  answer as answerPlan, cancel as cancelPlan, dismissAll as dismissAllPlans,
  getPendingPlan, planSessionIds, register as registerPlan, sanitizePlan
} from './lib/plans.js';
import { notifyPermission, permissionWaits } from './lib/permissions.js';
import { maybeSend, sendTest } from './lib/notify.js';
import { getState, setEnabled } from './lib/remoteState.js';
import { getSettings, setSettings } from './lib/settings.js';
import { classifyOrigin } from './lib/origin.js';
import { toPosInt, type Config } from './lib/config.js';
import type {
  AnalyticsResponse, ManagementIndex, PlanWaitResult, ScopeConfig, SessionPlan,
  SessionQuestion, SessionsResponse, SessionChat, SessionDetail, WaitResult
} from '../shared/types.js';

/** Session ids are transcript filenames (UUIDs) — restrict to safe chars. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Hard ceilings for the per-request scan overrides below. `limit` is the one
 * that matters: unclamped, a single typo'd query string would make the server
 * tail-read thousands of transcripts on every 3-second poll.
 */
const SCAN_CAPS = { limit: 50, lookback: 168, active: 120 } as const;

/**
 * Apply the Settings page's scan knobs, which ride along as query params on the
 * poll the client already makes (`?limit=&lookback=&active=`). They are per
 * device, so they stay stateless request input rather than server state —
 * nothing here is persisted, and an absent or unusable value falls back to the
 * configured default. Pure; unit-tested in `test/scan-params.test.ts`.
 */
export function scanOverrides(config: Config, params?: URLSearchParams): Config {
  if (!params) return config;
  const pick = (key: string, fallback: number, cap: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    return Math.min(cap, toPosInt(raw, fallback));
  };
  return {
    ...config,
    maxSessions: pick('limit', config.maxSessions, SCAN_CAPS.limit),
    lookbackHours: pick('lookback', config.lookbackHours, SCAN_CAPS.lookback),
    activeWindowMin: pick('active', config.activeWindowMin, SCAN_CAPS.active)
  };
}

export function serveSessions(baseConfig: Config, res: ServerResponse, params?: URLSearchParams): void {
  const config = scanOverrides(baseConfig, params);
  let data: SessionsResponse;
  try {
    // pendingIds comes from the RAM store, not disk: a question held by the
    // AskUserQuestion hook is flagged on its row before the transcript knows
    // about it, so it's visible without opening the chat drawer. planIds is the
    // same thing for a held ExitPlanMode call.
    // permissionWaits likewise: a terminal permission dialog is TUI-only and
    // never reaches the transcript, so the Notification hook is the only way the
    // scan can know a session is parked on one.
    data = scanSessions(config, {
      skipProcScan: config.skipProcScan,
      pendingIds: pendingSessionIds(),
      planIds: planSessionIds(),
      permissionWaits: permissionWaits()
    });
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
 * `GET /api/sessions/:id/chat` — a page of the session's chat history.
 * No query → the newest page (tail); `?after=<cursor>` → only what was appended
 * since (the 3s live tail); `?before=<headOffset>` → the page above. Offsets are
 * byte offsets into the transcript (see lib/chat.ts). The id is resolved against
 * the enumerated transcript list, never joined into a path.
 *
 * `?full=1` lifts the per-message caps — request input, not stored state, the
 * same way the scan knobs ride the sessions poll. The page is still bounded by
 * one `CHAT_WINDOW_BYTES` window either way.
 */
export function serveSessionChat(id: string, params: URLSearchParams, res: ServerResponse): void {
  const fail = (code: number): void => {
    const body: SessionChat = { id, messages: [], cursor: 0, headOffset: 0, hasMore: false, error: true };
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!ID_RE.test(id)) return fail(400);

  const offset = (name: string): number | null | undefined => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const after = offset('after');
  const before = offset('before');
  if (after === null || before === null) return fail(400);
  const caps = params.get('full') === '1' ? NO_CAPS : DEFAULT_CAPS;

  let body: SessionChat;
  try {
    const ref = listTranscripts(projectsRoot()).find(t => t.id === id);
    if (!ref) return fail(404);
    const chat =
      after !== undefined ? readChatAfter(ref.file, after, caps)
      : before !== undefined ? readChatBefore(ref.file, before, CHAT_PAGE_MESSAGES, caps)
      : readChatTail(ref.file, CHAT_PAGE_MESSAGES, caps);
    if (!chat) return fail(404);
    body = { id, ...chat };
  } catch (e) {
    console.error('[dashboard] session chat failed:', (e as Error).message);
    return fail(500);
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/* -------------------------------------------------- remote-answer endpoints */

/** Request-body cap. A sanitized AskUserQuestion input is ~1 KB. */
const BODY_CAP = 64 * 1024;

/** Buffer and parse a JSON request body. null on overflow, bad JSON, or abort. */
export function readJsonBody(req: IncomingMessage, cap = BODY_CAP): Promise<unknown | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: unknown | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(null); }
    });
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

/**
 * Bearer check for the two write endpoints. An unset ANSWER_TOKEN leaves them
 * open — the same posture as every read endpoint here.
 */
function tokenOk(config: Config, req: IncomingMessage): boolean {
  if (!config.answerToken) return true;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${config.answerToken}`;
}

/** True when the id names a transcript we can see. Never joined into a path. */
function sessionExists(id: string): boolean {
  try { return listTranscripts(projectsRoot()).some(t => t.id === id); }
  catch { return false; }
}

/**
 * `GET /api/health` — the hook's reachability probe, and the client's read of the
 * remote-answer switch. `remoteAnswer` is the single field the hook acts on; the
 * rest lets the UI explain *why* it's off.
 *
 * `idleSecs` and `answerSecs` ride along because the hooks need both immediately
 * after this probe (`ask-remote-hook.sh`), and a second round trip to fetch two
 * integers would add latency to every question they intercept.
 */
export function serveHealth(config: Config, res: ServerResponse, req?: IncomingMessage): void {
  const settings = getSettings();
  sendJson(res, 200, {
    ok: true,
    ...getState(config),
    idleSecs: settings.idleSecs,
    answerSecs: settings.answerSecs,
    origin: classifyOrigin(req?.socket?.remoteAddress, req?.headers)
  });
}

/**
 * `GET /api/settings` — the settings that aren't per-device (see lib/settings.ts).
 *
 * `notifyAvailable` is filled here rather than in the store: it is the one field
 * derived from `Config`, and `lib/settings.ts` deliberately never reads config.
 * The topic itself is never returned — it is both the address and the credential.
 */
export function serveSettingsRead(config: Config, res: ServerResponse): void {
  sendJson(res, 200, { ...getSettings(), notifyAvailable: config.ntfyTopic !== '' });
}

/**
 * `POST /api/settings` — change them from the Settings page. Token-guarded like
 * the other write endpoints; 400 rather than a silent no-op when the body
 * carries nothing usable, so the UI never shows a value the server refused.
 */
export async function serveSettingsWrite(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  const body = await readJsonBody(req);
  const next = setSettings(body);
  if (!next) {
    return sendJson(res, 400, { error: 'expected {idleSecs?: number, answerSecs?: number, notify?: NotifyPolicy}' });
  }
  sendJson(res, 200, { ...next, notifyAvailable: config.ntfyTopic !== '' });
}

/**
 * `POST /api/remote-answer` — flip the toggle from the dashboard. 409 when
 * `REMOTE_ANSWER=false` has disabled the feature outright (a UI toggle must not
 * silently override the config kill switch).
 */
export async function serveRemoteAnswerToggle(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  const body = await readJsonBody(req) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'expected {enabled: boolean}' });
  const state = setEnabled(config, body.enabled);
  if (!state) return sendJson(res, 409, { error: 'disabled by REMOTE_ANSWER=false' });
  // Switching off releases the waits we already hold — their terminal dialogs
  // appear within a second instead of sitting out the full window. One switch,
  // both stores: a held plan is as remote as a held question.
  const released = body.enabled ? 0 : dismissAll() + dismissAllPlans();
  sendJson(res, 200, { ...state, released });
}

/**
 * `POST /api/questions/wait` — a session's AskUserQuestion hook offers its
 * question and waits here. The response is HELD until the browser answers, the
 * user sends it back to the terminal, the deadline passes, or a newer question
 * supersedes it; the body is then a {@link WaitResult}.
 *
 * Any non-200 makes the hook exit 0, i.e. the terminal dialog appears — so every
 * rejection below degrades to the pre-feature behaviour rather than blocking the
 * session. The id is checked against the enumerated transcript list, never joined
 * into a path (same rule as the read endpoints).
 */
export async function serveQuestionWait(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; toolInput?: unknown; timeoutMs?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });
  if (!sessionExists(sessionId)) return sendJson(res, 404, { error: 'unknown session' });

  const questions = sanitizeQuestions(body.toolInput);
  if (questions.length === 0) return sendJson(res, 400, { error: 'no usable questions' });

  // The hook's socket closing IS the signal that nobody is waiting any more
  // (session interrupted, hook killed, CLI hook timeout). Listen before
  // registering, and re-check after, so a socket that dies during the body read
  // can't leave an entry parked until its deadline.
  let questionId = '';
  res.on('close', () => { if (questionId) cancelPending(sessionId, questionId); });
  questionId = register(sessionId, questions, clampTimeout(body.timeoutMs), (result: WaitResult) => {
    if (res.writableEnded) return;
    sendJson(res, 200, result);
  });
  if (res.destroyed) cancelPending(sessionId, questionId);

  // Last, so a refused registration never pushes. Returns immediately — the
  // response above stays held either way.
  maybeSend(config, 'question', {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
}

/** `GET /api/sessions/:id/question` — what this session is waiting on, if anything. */
export function serveSessionQuestion(id: string, res: ServerResponse): void {
  if (!ID_RE.test(id)) {
    const body: SessionQuestion = { id, pending: null, error: true };
    return sendJson(res, 400, body);
  }
  sendJson(res, 200, { id, pending: getPending(id) } satisfies SessionQuestion);
}

/**
 * `POST /api/sessions/:id/answer` — deliver the user's pick (or `dismiss: true`
 * to hand the question back to the terminal). 404 means the wait is already over:
 * answered elsewhere, expired, or the hook is gone.
 */
export async function serveSessionAnswer(
  config: Config, id: string, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!config.remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'bad body' });

  switch (answerPending(id, body)) {
    case 'ok': return sendJson(res, 200, { ok: true });
    case 'not-found': return sendJson(res, 404, { error: 'no question is waiting' });
    case 'mismatch': return sendJson(res, 409, { error: 'that question is no longer the one waiting' });
    default: return sendJson(res, 400, { error: 'bad answer' });
  }
}

/**
 * `POST /api/plans/wait` — a session's `PermissionRequest[ExitPlanMode]` hook
 * offers its proposed plan and waits here. Held exactly like the question wait,
 * and every rejection below likewise degrades to the plan card rather than
 * blocking the session.
 */
export async function servePlanWait(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; toolInput?: unknown; timeoutMs?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });
  if (!sessionExists(sessionId)) return sendJson(res, 404, { error: 'unknown session' });

  const plan = sanitizePlan(body.toolInput);
  if (!plan) return sendJson(res, 400, { error: 'no usable plan' });

  let planId = '';
  res.on('close', () => { if (planId) cancelPlan(sessionId, planId); });
  planId = registerPlan(sessionId, plan, clampTimeout(body.timeoutMs), (result: PlanWaitResult) => {
    if (res.writableEnded) return;
    sendJson(res, 200, result);
  });
  if (res.destroyed) cancelPlan(sessionId, planId);

  maybeSend(config, 'plan', {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
}

/** `GET /api/sessions/:id/plan` — the plan this session is waiting on, if any. */
export function serveSessionPlan(id: string, res: ServerResponse): void {
  if (!ID_RE.test(id)) {
    const body: SessionPlan = { id, pending: null, error: true };
    return sendJson(res, 400, body);
  }
  sendJson(res, 200, { id, pending: getPendingPlan(id) } satisfies SessionPlan);
}

/**
 * `POST /api/sessions/:id/plan-answer` — send a plan back for revision
 * (`{verdict: 'reject', feedback}`) or hand it to its card (`'dismiss'`).
 *
 * ⚠️ No accept verdict, and adding one would not work: the CLI discards a hook
 * `allow` for tools that declare `requiresUserInteraction()`. See
 * {@link PlanAnswerRequest}.
 */
export async function serveSessionPlanAnswer(
  config: Config, id: string, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!config.remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'bad body' });

  switch (answerPlan(id, body)) {
    case 'ok': return sendJson(res, 200, { ok: true });
    case 'not-found': return sendJson(res, 404, { error: 'no plan is waiting' });
    case 'mismatch': return sendJson(res, 409, { error: 'that plan is no longer the one waiting' });
    default: return sendJson(res, 400, { error: 'bad verdict' });
  }
}

/**
 * `POST /api/permissions/notify` — the PermissionRequest hook (or the older
 * Notification one) reporting that a session is showing an interactive
 * permission dialog. Body
 * `{sessionId, message?}`; the store keeps only the id and the arrival time.
 *
 * Write-shaped but not a control path: the flag decorates a row, and nothing
 * can answer the dialog remotely. Still token-gated like the other POSTs, since
 * it can otherwise be used to light up rows from anywhere on the LAN. The hook
 * ignores the response entirely — every failure here is invisible to the CLI.
 */
export async function servePermissionNotify(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; message?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });
  if (!sessionExists(sessionId)) return sendJson(res, 404, { error: 'unknown session' });

  notifyPermission(sessionId, body.message);
  maybeSend(config, 'permission', {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
  sendJson(res, 200, { ok: true });
}

/**
 * `POST /api/notify/event` — the `stop` hook's path in. Fire-and-forget like
 * `/api/permissions/notify`: the hook does not care what happens next, and a
 * push must never delay the end of a turn.
 *
 * The three other events do not use this route — they are already registering
 * something here, so they notify inline.
 *
 * Unlike the wait endpoints this does NOT call `sessionExists`: a `stop` hook
 * fires as the turn ends, which is exactly when the transcript may not yet be
 * on disk for the scan to see, and rejecting there would drop the most common
 * push. The id is still shape-checked and never joined into a path.
 */
export async function serveNotifyEvent(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; event?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });

  const event = body.event;
  if (event !== 'question' && event !== 'stop' && event !== 'permission' && event !== 'plan') {
    return sendJson(res, 400, { error: 'bad event' });
  }

  maybeSend(config, event, {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
  sendJson(res, 200, { ok: true });
}

/** `POST /api/notify/test` — fire one push regardless of policy and report the outcome. */
export async function serveNotifyTest(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  sendJson(res, 200, { outcome: await sendTest(config) });
}

/* -------------------------------------------------- management endpoints */

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function emptyScope(scope: 'global' | 'project', root = ''): ScopeConfig {
  return { scope, root, skills: [], agents: [], commands: [], rules: [], hooks: [], memory: [], settings: [], plugins: [] };
}

/**
 * `GET /api/management` — the global scope (incl. plugins) + recent projects.
 * Fetched on section open, not polled: config changes on the order of days.
 */
export async function serveManagementIndex(config: Config, res: ServerResponse): Promise<void> {
  let data: ManagementIndex;
  try {
    const [global, projects] = await Promise.all([
      readGlobalScope(),
      Promise.resolve(listRecentProjects(config))
    ]);
    data = { generatedAt: new Date().toISOString(), global, projects };
  } catch (e) {
    console.error('[dashboard] management index failed:', (e as Error).message);
    data = { error: true, generatedAt: new Date().toISOString(), global: emptyScope('global', claudeHome()), projects: [] };
  }
  sendJson(res, 200, data);
}

/**
 * `GET /api/management/project?dir=<dirName>` — one project's scope. The
 * dirName is resolved against the enumerated recent-project list, never
 * joined into a path (same philosophy as serveSessionDetail).
 */
export async function serveManagementProject(config: Config, dirName: string, res: ServerResponse): Promise<void> {
  if (!ID_RE.test(dirName)) return sendJson(res, 400, { ...emptyScope('project'), error: true });
  try {
    const ref = resolveProject(config, dirName);
    if (!ref) return sendJson(res, 404, { ...emptyScope('project'), error: true });
    sendJson(res, 200, await readProjectScope(ref.path, ref.dirName));
  } catch (e) {
    console.error('[dashboard] management project failed:', (e as Error).message);
    sendJson(res, 500, { ...emptyScope('project'), error: true });
  }
}

/**
 * `GET /api/management/file?path=<abs>` — one enumerated file's content.
 * 400 malformed path, 403 not in the servable set, 404 vanished on disk.
 */
export async function serveManagementFile(config: Config, rawPath: string, res: ServerResponse): Promise<void> {
  const p = rawPath;
  const fail = (code: number) => sendJson(res, code, { path: p, content: '', size: 0, truncated: false, error: true });
  if (!p || !p.startsWith('/') || p.includes('..')) return fail(400);
  try {
    const allowed = await collectServablePaths(config);
    if (!allowed.has(p)) return fail(403);
    const file = await readServableFile(p, allowed);
    if (!file) return fail(404);
    sendJson(res, 200, file);
  } catch (e) {
    console.error('[dashboard] management file failed:', (e as Error).message);
    fail(500);
  }
}

/* -------------------------------------------------- analytics endpoint */

/**
 * `GET /api/analytics` — the last N sessions `/kaizen` has logged, newest-first,
 * each enriched with a live re-run of the analyzer. Read-only; `/kaizen` is the
 * sole producer. Not polled; fetched on section mount and manual refresh. Fails
 * open to an empty list.
 */
export function serveAnalytics(config: Config, res: ServerResponse): void {
  const body: AnalyticsResponse = { generatedAt: new Date().toISOString(), keep: config.analyticsKeep, reports: [] };
  try {
    body.reports = listReports(config.analyticsKeep);
    const review = reviewStatus();
    body.lastReviewAt = review.lastReviewAt;
    body.reviewDue = review.reviewDue;
  } catch (e) {
    console.error('[dashboard] analytics list failed:', (e as Error).message);
    body.error = true;
  }
  sendJson(res, 200, body);
}
