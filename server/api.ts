/**
 * api.ts — the `/api/sessions` endpoints. `serveSessions` writes the ranked
 * snapshot; `serveSessionDetail` writes one session's subagent activity. Both
 * fall back to a safe empty payload if the scan throws.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import nodePath from 'node:path';

import type { HubHandler } from 'lookout-widgets';

import {
  scanSessions, lastMessageMs, listTranscripts, findTranscript, liveSessionIds, projectsRoot, sessionFromRef, sessionSurface
} from './lib/scan.js';
import { readSessionAnalyticsLog } from './lib/sessionAnalyticsLog.js';
import { archivedSessionIds } from './lib/archived.js';
import { lastSessionEffort, readTranscript } from './lib/transcript.js';
import { readAgentsCached } from './lib/agents-cache.js';
import { getCachedUsageState } from './lib/usage.js';
import { isRefreshSession } from './lib/token-refresh.js';
import { readAccountProfile } from './lib/account.js';
import { deriveProfile, profileSnapshot, RATES_HISTORY_BYTES, readRecentSamples, readSamplesSince } from './lib/usage-history.js';
import { buildUsageHistory } from './lib/usage-history-series.js';
import type { ProfileState, UsageSample } from './lib/usage-history.js';
import { ledgerStartMs, readLedgerSince } from './lib/usage-ledger.js';
import type { LedgerLine } from './lib/usage-ledger.js';
import {
  BASELINE_MS, WEEKLY_FLOORS, coverageBreakdown, currentRange, dailyRates, driftRow, externalShare,
  fitDeviation, fitRates, fitSplits, joinIntervals, joinWeeklyIntervals, ledgerBreakMs,
  poolRate, rateFor
} from './lib/usage-rate.js';
import { detectBoost, emptyBoost } from './lib/usage-boost.js';
import { HOURS_PER_WEEK, confidenceOf, localOffsetMinutes, walkForward } from './lib/usage-forecast.js';
import {
  claudeHome, collectServablePaths, defaultClaudeRoots, isClaudeOwned, listOlderProjects, listPinRows,
  listRecentProjects, readGlobalScope, readProjectScope, readServableFile, resolveProject
} from './lib/management.js';
import { listReports, reviewStatus } from './lib/analytics.js';
import {
  CHAT_PAGE_MESSAGES, DEFAULT_CAPS, NO_CAPS, readChatAfter, readChatBefore, readChatTail
} from './lib/chat.js';
import {
  answer as answerPending, cancel as cancelPending, clampTimeout,
  dismissAll, getPending, pendingSessionIds, register, sanitizeQuestions,
  sweepDecided as sweepDecidedPending
} from './lib/pending.js';
import {
  answer as answerPlan, cancel as cancelPlan, dismissAll as dismissAllPlans,
  getPendingPlan, planSessionIds, register as registerPlan, sanitizePlan,
  sweepDecided as sweepDecidedPlans
} from './lib/plans.js';
import {
  answer as answerMessage, cancel as cancelMessage, dismissAll as dismissAllMessages,
  getPendingMessage, messageSessionIds, register as registerMessage
} from './lib/messages.js';
import { notifyPermission, permissionWaits } from './lib/permissions.js';
import { maybeSend, sendTest } from './lib/notify.js';
import { getState, setEnabled } from './lib/remoteState.js';
import { getPinnedProjects, getSettings, setPinOrder, setPinned, setSettings } from './lib/settings.js';
import { fetchAll, markGitWatched } from './lib/git-fetch.js';
import { openFolder, openFolderPlatform, revealFile } from './lib/open-folder.js';
import { runQuickOp } from './lib/git-quick.js';
import { readSessionPr } from './lib/pr-detect.js';
import { GH_PR_RE, readPrStatus } from './lib/pr-status.js';
import { readGitStats } from './lib/git-stats.js';
import { readCodegraph, startCodegraphRun } from './lib/codegraph-store.js';
import { classifyOrigin, resolvePeer } from './lib/origin.js';
import { releasesPayload } from './lib/releases.js';
import { extForMime, isTranscribing, probeTranscribe, transcribe } from './lib/transcribe.js';
import {
  EFFORTS, MAX_LAUNCHING, adoptLaunched, clampPermission, forceStopSession, hasLiveChild, launch, listLaunching, parseSpawnRequest,
  probeSpawn, stopSession, stopStates
} from './lib/spawn.js';
import { staleEnvKeys, toPosInt, type Config } from './lib/config.js';
import { describeCron, isManualCron, nextAfter, parseCron } from '../shared/cron.js';
import { checkPins, parseJob, serializeEnabled } from '../shared/routine-file.js';
import type { JobError, PinSnapshot } from '../shared/routine-file.js';
import { foldForPush, ownerStatus, runsReader } from './lib/routine-boot.js';
import { machineName, routineDirs } from './lib/routine-config.js';
import { computeStats } from './lib/routine-log.js';
import { applyReconcile, lastReconcile, planReconcile, scheduled } from './lib/routine-reconcile.js';
import { runJob, stopJob } from './lib/routine-run.js';
import { RoutineStoreError, deleteJob, isOwner, readJobs, writeJob, writePinsSnapshot } from './lib/routine-store.js';
import type {
  AnalyticsResponse, GitQuickRequest, ManagementIndex, MessageWaitResult, OpenFolderResponse, PinsResponse, PlanWaitResult, ScopeConfig,
  SessionMessage, SessionPlan, SessionPrInfo, SessionPrResponse, SessionQuestion, SessionsResponse, SessionChat, SessionDetail, SpawnRequest,
  ModelRateRow, RateLimit, ServerSettings, SpawnResponse, UsageCoverage, UsageProfileCell,
  UsageHistoryResponse, UsageProfileResponse, UsageRatesResponse, WaitResult, ConnectionOrigin, WriteAccess,
  ReconcileReport, RoutineFile, RoutineJob, RoutineJobRow, RoutineRunsResponse, RoutinesResponse, RoutineValidateResponse, Session
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

/**
 * Release held question/plan waits whose session has moved on — the terminal
 * card decided it. The CLI renders that card *alongside* the hook and, when the
 * card wins, abandons the hook without killing it: `curl` stays connected, so no
 * socket closes and neither store hears anything. Without this the entry sits
 * out its whole deadline (up to 10 min) with the dashboard still offering an
 * answer nothing will read.
 *
 * Runs off the scan tick and only while holds exist, so an idle server does no
 * extra IO — the same shape as `messages.ts`'s idle reaper. One transcript read
 * per held wait, and there is at most one per session.
 */
function sweepTerminalDecisions(): void {
  if (pendingSessionIds().size === 0 && planSessionIds().size === 0) return;
  const root = projectsRoot();
  const movedOn = (sessionId: string, askedAtMs: number): boolean => {
    const ms = lastMessageMs(root, sessionId);
    return ms !== null && ms > askedAtMs;
  };
  sweepDecidedPending(movedOn);
  sweepDecidedPlans(movedOn);
}

/** One scan of the session rows with every RAM-store injection applied — what `/api/sessions` serves before launches and usage are attached. */
export function scanSnapshot(config: Config, projects?: ReadonlySet<string> | null): SessionsResponse {
  // Before the scan, not after: a wait the terminal already decided must not
  // colour this tick's row blue either.
  sweepTerminalDecisions();
  // pendingIds comes from the RAM store, not disk: a question held by the
  // AskUserQuestion hook is flagged on its row before the transcript knows
  // about it, so it's visible without opening the chat drawer. planIds and
  // messageIds are the same thing, for a held ExitPlanMode call and a held
  // Stop-hook reply window respectively.
  // permissionWaits likewise: a terminal permission dialog is TUI-only and
  // never reaches the transcript, so the Notification hook is the only way the
  // scan can know a session is parked on one.
  // archivedIds mirrors the desktop app's own list: "delete" there is an
  // archive that leaves the transcript on disk, so without this the row keeps
  // showing until it ages out of the lookback window. Read here, not in
  // scan.ts, so the scan stays free of the app's store (see archived.ts).
  return scanSessions(config, {
    skipProcScan: config.skipProcScan,
    pendingIds: pendingSessionIds(),
    planIds: planSessionIds(),
    messageIds: messageSessionIds(),
    permissionWaits: permissionWaits(),
    archivedIds: archivedSessionIds(),
    // stopStates is the same injection again, and the only one that is not a
    // hint about a wait: it says which rows this server can actually signal,
    // so the Stop control is offered only where it would work.
    stopStates: stopStates(),
    projects
  });
}

/** The Sessions toolbar's project filter, as repeated `?project=` params; empty values dropped. null = no filter. */
export function projectParams(params?: URLSearchParams): Set<string> | null {
  const names = (params?.getAll('project') ?? []).filter(Boolean);
  return names.length ? new Set(names) : null;
}

export function serveSessions(baseConfig: Config, res: ServerResponse, params?: URLSearchParams): void {
  const config = scanOverrides(baseConfig, params);
  let data: SessionsResponse;
  try {
    data = scanSnapshot(config, projectParams(params));
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
  // Adopt before listing: a launch id that just showed up in `sessions` must
  // not also be reported as still `launching` in the same poll. Attached on
  // the error snapshot too — a failed scan is exactly when "did my launch
  // work?" matters most (see server/lib/spawn.ts).
  adoptLaunched(data.sessions.map(s => s.id));
  data.launching = listLaunching();
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
 * agents-cache.ts). The list poll touches the same cache only through scan.ts
 * `subagentRunning`, and only for a session with a fresh, unfinished subagent.
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
    const ref = findTranscript(projectsRoot(), id);
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
    const ref = findTranscript(projectsRoot(), id);
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

/** Audio-body cap. A 120s AAC clip is ~2MB; 8MB leaves room for verbose codecs. */
const AUDIO_CAP = 8 * 1024 * 1024;

/** A fully buffered request body, or the reason it never completed. */
export type ReadBody =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'overflow' | 'aborted' };

/**
 * Buffer a request body up to `cap` bytes — the only request-stream plumbing in
 * this file. `readJsonBody` and `readBinaryBody` are wrappers over it. They were
 * two near-identical copies that differed only in how they finished, and they
 * drifted on exactly the point below, so it is stated once, here.
 *
 * On overflow this resolves but deliberately does NOT `req.destroy()`: `req` and
 * `res` share one socket, so destroying the request tears that socket down
 * before the caller's error response can go out, and the client gets a bare
 * connection reset instead of the JSON. Closing is the caller's job, sequenced
 * from `res.on('finish')` once the response has flushed — see `sendBadBody` for
 * the 400 path and `send413` for the transcribe path.
 *
 * Buffered chunks are dropped on overflow rather than left sitting at ~cap bytes
 * until GC; `size` never shrinks, so every later chunk lands in the same branch
 * and memory stays bounded from then on. The stream still drains because this
 * 'data' listener stays attached and keeps it flowing — removing it as a later
 * "optimization" would stall the socket instead of draining it.
 */
export function readBody(req: IncomingMessage, cap: number): Promise<ReadBody> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: ReadBody): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        chunks.length = 0;
        finish({ ok: false, reason: 'overflow' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, bytes: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, reason: 'aborted' }));
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }));
  });
}

/**
 * Buffer and parse a JSON request body. null on overflow, bad JSON, or abort:
 * every caller answers 400 to all three, so `readBody`'s distinction is
 * collapsed here rather than re-branched at every call site.
 */
export async function readJsonBody(req: IncomingMessage, cap = BODY_CAP): Promise<unknown | null> {
  const body = await readBody(req, cap);
  if (!body.ok) return null;
  try { return JSON.parse(body.bytes.toString('utf8')); }
  catch { return null; }
}

/**
 * Buffer a raw request body. Keeps the overflow/abort distinction that
 * `readJsonBody` throws away, because the transcribe endpoint answers 413 for
 * one and 400 for the other.
 */
export function readBinaryBody(req: IncomingMessage, cap = AUDIO_CAP): Promise<ReadBody> {
  return readBody(req, cap);
}

/**
 * Send the 413 and close the connection afterwards. `readBinaryBody` can't
 * sequence this itself — it never sees `res` — so the other half of "don't
 * leave an over-cap client sitting on an open socket" lives here. Waits for
 * `finish` (the response fully handed to the socket) before destroying, so
 * the 413 body itself is never truncated. Without this, a rejected upload
 * could otherwise hold its connection for up to Node's default requestTimeout
 * on the one endpoint whose whole job is spawning CPU-saturating subprocesses.
 *
 * The JSON body is best-effort, not guaranteed: a client still mid-upload when
 * this fires typically sees the destroyed socket as a TCP RST, which discards
 * whatever of the response was sitting in its receive buffer, body included.
 * That's fine — severing the connection is the actual point, not the body
 * reaching the client (the composer maps a network error and a 413 to the
 * same message either way).
 */
function send413(res: ServerResponse, body: unknown): void {
  res.setHeader('Connection', 'close');
  res.on('finish', () => res.socket?.destroy());
  sendJson(res, 413, body);
}

/**
 * `POST /api/transcribe` — a recorded clip in, one line of text out.
 *
 * Gated like the session write paths (remote-answer switch, then the write gate)
 * even though it writes no session state, so it is not counted as one: it
 * spawns processes and writes files on this machine, which is firmly the write
 * side of the line this codebase draws. The write gate comes before the engine probe so
 * an unauthenticated caller gets no further than 403 on a path that spawns
 * processes — not to hide the capability itself: `GET /api/health` already
 * publishes `transcribe` with no auth at all, by design. `serveSpawn` below
 * runs those two the other way round; the paragraph there explains why that is
 * harmless, so don't "fix" either one into matching the other. See
 * docs/subsystems/dictation.md.
 */
export async function serveTranscribe(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (refuseWrite(config, req, res)) return;
  if (!probeTranscribe(config)) return sendJson(res, 404, { error: 'no transcription engine' });
  // Cheap pre-buffer peek: refuse a second caller before its audio is ever
  // read into memory, rather than after (see docs/subsystems/dictation.md).
  // This is an optimisation, not the authority — the `busy` mapping below,
  // driven by `transcribe()`'s own `inFlight` check, still has to stay:
  // `inFlight` only flips true once `transcribe()` starts, after the body
  // below is already buffered, so this only catches a caller arriving while
  // a transcription is already running — simultaneous callers can each read
  // `isTranscribing() === false` and buffer before any of them sets the flag.
  if (isTranscribing()) return sendJson(res, 429, { error: 'busy' });

  const mime = String(req.headers['content-type'] || '');
  const ext = extForMime(mime);
  if (!ext) return sendJson(res, 400, { error: `unsupported audio type: ${mime}` });

  // An honest Content-Length already over the cap needs no bytes read to
  // reject — skip straight to the same 413 an overflow would reach after
  // buffering the whole thing. Chunked transfers and clients that lie about
  // this header still fall through to the byte-counted check below.
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > AUDIO_CAP) {
    return send413(res, { error: 'clip too large' });
  }

  const body = await readBinaryBody(req, AUDIO_CAP);
  if (!body.ok) {
    return body.reason === 'overflow'
      ? send413(res, { error: 'clip too large' })
      : sendJson(res, 400, { error: 'upload aborted' });
  }
  if (body.bytes.length === 0) return sendJson(res, 400, { error: 'empty body' });

  const out = await transcribe(config, body.bytes, ext);
  if (out.ok) return sendJson(res, 200, { text: out.text });
  const code = out.reason === 'busy' ? 429 : out.reason === 'timeout' ? 504 : 500;
  return sendJson(res, code, { error: out.reason });
}

/**
 * Answer 400 to a body we refused, then close the connection.
 *
 * `readJsonBody` cannot sequence this itself — it never sees `res` — so the
 * other half of "an over-cap client must not keep uploading a body we already
 * rejected" lives here. Waiting for `finish` (the response fully handed to the
 * socket) before destroying is what makes the reply arrive at all: tearing the
 * shared socket down any earlier truncates the 400 into a connection reset.
 *
 * Used for every bad-body 400, not just overflow — the reader collapses
 * overflow and malformed JSON into the same `null`, and closing after a
 * malformed body costs nothing, since that request has already ended.
 */
function sendBadBody(res: ServerResponse, body: unknown): void {
  res.setHeader('Connection', 'close');
  res.on('finish', () => res.socket?.destroy());
  sendJson(res, 400, body);
}

/** How long one rejected path stays quiet after it has been logged once. */
const REJECT_LOG_WINDOW_MS = 60_000;

/** Last log time per `METHOD /path`. Capped — see `logRejectedWrite`. */
const rejectLogged = new Map<string, number>();

/** Reset the throttle. Same convention as the `resetStore` exports in `lib/*`. */
export function resetRejectedWriteLog(): void {
  rejectLogged.clear();
}

/**
 * Say once, on stderr, that a write was refused, from which kind of peer, and whether a token would have helped.
 *
 * Silence here is what made backlog bug-6 cost twelve hours: the installer had
 * written no token file, every hook POST came back 403, and the hooks swallow
 * that (`curl -sf`, then `exit 0`). Nothing on any surface distinguished a
 * misconfigured token from a feature nobody had switched on.
 *
 * Method, path and peer class only. Never the expected token, the received header, or a
 * prefix of either — a log that carries the credential is a worse bug than the
 * one it diagnoses — and never the query string, which is the one part of a URL
 * a caller might have put a secret in.
 *
 * Throttled per path because a held `stop` hook retries: an unthrottled line
 * would bury the output it is supposed to draw attention to.
 */
function logRejectedWrite(req: IncomingMessage, peer: ConnectionOrigin, kind: 'token' | 'read-only'): void {
  const key = `${req.method || 'GET'} ${(req.url || '').split('?')[0]}`;
  const now = Date.now();
  const last = rejectLogged.get(key);
  if (last !== undefined && now - last < REJECT_LOG_WINDOW_MS) return;
  // Paths carry session ids, so the key space is unbounded over a long run.
  if (rejectLogged.size >= 256) rejectLogged.clear();
  rejectLogged.set(key, now);
  const why = kind === 'token' ? 'bad or missing token' : 'read-only, no token set';
  console.error(`[dashboard] rejected write: ${key} from ${peer} (${why})`);
}

/**
 * What a peer may do without presenting a token: `open` for this machine, and for the tailnet while `trustTailnet` is on; otherwise `token` when one
 * is configured, else `none`. The rule table lives in docs/subsystems/remote-access.md.
 */
export function writeAccessFor(peer: ConnectionOrigin, trustTailnet: boolean, tokenSet: boolean): WriteAccess {
  if (peer === 'local' || (peer === 'tailnet' && trustTailnet)) return 'open';
  return tokenSet ? 'token' : 'none';
}

/** `writeAccessFor` for this request. Reads the switch per call, which is what makes it live without a restart. */
function requestWriteAccess(config: Config, req: IncomingMessage): { peer: ConnectionOrigin; access: WriteAccess } {
  const peer = resolvePeer(req.socket?.remoteAddress, req.headers);
  return { peer, access: writeAccessFor(peer, getSettings().trustTailnet, config.answerToken !== '') };
}

/** `header` is exactly `Bearer <token>`, compared in constant time. Both sides are hashed first, so a length mismatch neither throws nor answers early. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));
}

/**
 * The gate every write route runs: true when it has already sent the 403 and the caller must return. A trusted peer passes; so does an exact
 * `Bearer <ANSWER_TOKEN>` from anywhere. The two refusal bodies tell a client whether a token could help (`bad token`) or not (`read-only from this
 * network`).
 */
export function refuseWrite(config: Config, req: IncomingMessage, res: ServerResponse): boolean {
  const { peer, access } = requestWriteAccess(config, req);
  if (access === 'open') return false;
  if (access === 'token' && bearerMatches(req.headers.authorization, config.answerToken)) return false;
  const kind = access === 'token' ? 'token' : 'read-only';
  logRejectedWrite(req, peer, kind);
  sendJson(res, 403, { error: kind === 'token' ? 'bad token' : 'read-only from this network' });
  return true;
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
export function serveHealth(config: Config, res: ServerResponse, req: IncomingMessage): void {
  const settings = getSettings();
  const { access } = requestWriteAccess(config, req);
  sendJson(res, 200, {
    ok: true,
    ...getState(config),
    idleSecs: settings.idleSecs,
    answerSecs: settings.answerSecs,
    origin: classifyOrigin(req.socket?.remoteAddress, req.headers),
    writeAccess: access,
    tokenRequired: access === 'token',
    transcribe: probeTranscribe(config),
    spawnAvailable: probeSpawn(config),
    spawnMaxPermission: config.spawnMaxPermission,
    syncPermissionMode: clampPermission(config.syncPermissionMode, config.spawnMaxPermission)
  });
}

/**
 * `GET /api/dismiss` — where a tapped desk notification lands, and it does
 * nothing on purpose.
 *
 * ntfy's service worker always acts on a click: with a `Click` header it
 * `openWindow`s that URL, and **without** one it opens its own topic page and
 * leaves that tab behind. There is no "inert notification" option. So the desk
 * push points here, and here serves a page whose only job is to close the tab it
 * arrived in — a click becomes a flash and nothing else.
 *
 * The tab can close itself because `clients.openWindow` gives it a single history
 * entry and no opener, which satisfies Blink's rule (`LocalDOMWindow::close`).
 * Confirmed in real use on 2026-09-04. The message is the fallback for an engine
 * that refuses.
 *
 * Static, no parameters, no state: this replaced a deep-link handoff that opened
 * the session's drawer in an already-open dashboard tab (see git history for
 * `lib/focus.ts`). That worked, and was dropped as more machinery than the
 * feature was worth.
 */
export function serveDismiss(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html>
<meta charset="utf-8">
<title>Dismissed</title>
<body style="font:14px system-ui;padding:2rem;color:#888">
<p id="m">Dismissed.</p>
<script>
window.close();
setTimeout(function () {
  document.getElementById('m').textContent = 'You can close this tab.';
}, 600);
</script>
`);
}

/**
 * The one `/api/settings` body, for GET and POST alike: the client replaces its
 * whole state with either reply, so a field only one of them filled would vanish
 * on the first save.
 *
 * `notifyAvailable`, `usageAvailable` and `staleEnvKeys` are filled here rather than in the store:
 * all three derive from `Config` or the `.env` baseline, and `lib/settings.ts`
 * deliberately never reads config. The topic itself is never returned — it is
 * both the address and the credential.
 */
function settingsBody(config: Config, settings: ServerSettings): ServerSettings {
  return {
    ...settings,
    notifyAvailable: config.ntfyTopic !== '',
    usageAvailable: config.showUsage,
    // Read per request, not cached: the whole point is to notice a file that
    // changed after this process read it. One `readFileSync` of a small file.
    staleEnvKeys: staleEnvKeys()
  } satisfies ServerSettings;
}

/** `GET /api/settings` — the settings that aren't per-device (see lib/settings.ts). */
export function serveSettingsRead(config: Config, res: ServerResponse): void {
  sendJson(res, 200, settingsBody(config, getSettings()));
}

/** An empty grid, for the fail-open path and for a never-recorded profile. */
function blankCells(): UsageProfileCell[] {
  return Array.from({ length: HOURS_PER_WEEK }, (_, hourOfWeek) => ({
    hourOfWeek, weight: null, observedMin: 0, staleWeeks: 0
  }));
}

/**
 * Shape one `GET /api/usage/profile` body. Pure — no clock, no disk, no
 * timezone — so every calendar edge is testable (test/usage-profile-api.test.ts).
 *
 * The walk is re-run here with the *same* implementation that produced the
 * projection in `usage-pace.ts`, so the inspector can never drift from what it
 * claims to disclose. And it deliberately carries **no raw samples and no file
 * paths** — cells and the walk only, the same posture as `NTFY_TOPIC` never
 * leaving the server.
 *
 * With recording off the learned cells are still returned (they are real
 * evidence, and this endpoint exists to disclose it) but `confidence` is `none`
 * and the walk is empty: nothing is feeding the forecast, so claiming otherwise
 * would be the dishonest option. The view leads with `recording: false`.
 */
export function shapeUsageProfile(opts: {
  recording: boolean;
  state: ProfileState;
  weekly: RateLimit | null;
  nowMs: number;
  offsetMinutes: number;
}): UsageProfileResponse {
  const { recording, state, weekly, nowMs, offsetMinutes } = opts;
  const profile = deriveProfile(state);

  const cells: UsageProfileCell[] = state.buckets.map((b, hourOfWeek) => {
    const stamp = b.weekStamp;
    return {
      hourOfWeek,
      weight: profile.weights[hourOfWeek],
      observedMin: b.lifetimeObservedMin,
      // Observed weeks after the one this bucket last saw traffic in — the same
      // count the fold's decay applies. `observedWeeks` never holds a future
      // week, so "after the stamp" already means "up to now".
      staleWeeks: stamp === null ? 0 : state.observedWeeks.filter((w) => w > stamp).length
    };
  });

  const rate = weekly?.ratePerHour ?? null;
  const resetsAtMs = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : Number.NaN;
  // The window's own two facts, reported whether or not a walk can be run:
  // the forecast page states them before any projection, so they follow the
  // *limits* being readable, not the profile being usable.
  const utilizationPct = typeof weekly?.utilization === 'number' ? weekly.utilization : null;
  const resetsAt = Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null;
  // Ordered, not combined: the strip states *which* precondition is missing, so
  // "there is nothing to draw" reads as a state rather than as a broken panel.
  // Recording first — with it off nothing else has been measured either.
  const absent: UsageProfileResponse['walkAbsent'] =
    !recording ? 'recording-off'
      : rate == null || rate <= 0 ? 'no-rate'
        : weekly?.utilization == null || !Number.isFinite(resetsAtMs) ? 'no-window'
          : null;

  if (absent !== null) {
    return {
      cells,
      globalMean: profile.globalMean,
      confidence: recording ? confidenceOf(profile) : 'none',
      recording,
      walk: [],
      exhaustAt: null,
      walkAbsent: absent,
      utilizationPct,
      resetsAt,
      // No walk, so no slices to weigh — null rather than 0, which would read
      // as a measured "never active".
      dutyCycle: null
    };
  }

  const walked = walkForward({
    nowMs,
    utilization: weekly!.utilization as number,
    activeRatePerHour: rate as number,
    profile,
    resetsAtMs,
    offsetMinutes
  });
  return {
    cells,
    globalMean: profile.globalMean,
    confidence: confidenceOf(profile),
    recording,
    walk: walked.steps.map((x) => ({
      t: new Date(x.tMs).toISOString(),
      gain: x.gain,
      cum: x.cum,
      weight: x.weight,
      learned: x.learned
    })),
    exhaustAt: walked.exhaustAtMs == null ? null : new Date(walked.exhaustAtMs).toISOString(),
    // A walked window has nothing absent to report; the field is the negative
    // space of `walk`, so a non-empty walk always pairs with null.
    walkAbsent: null,
    utilizationPct,
    resetsAt,
    dutyCycle: walked.dutyCycle
  };
}

/**
 * `GET /api/usage/profile` — the duty-cycle inspector's data. Read-only.
 *
 * Fails open to an empty grid rather than a 500: this is a disclosure view, and
 * a torn one is worse than an honest empty one.
 */
export function serveUsageProfile(res: ServerResponse): void {
  try {
    const now = Date.now();
    sendJson(res, 200, shapeUsageProfile({
      recording: getSettings().recordUsageHistory,
      state: profileSnapshot(),
      weekly: getCachedUsageState().usage?.sevenDay ?? null,
      nowMs: now,
      offsetMinutes: localOffsetMinutes(now)
    }));
  } catch {
    sendJson(res, 200, {
      cells: blankCells(), globalMean: 1, confidence: 'none',
      recording: false, walk: [], exhaustAt: null, walkAbsent: 'recording-off',
      utilizationPct: null, resetsAt: null, dutyCycle: null
    } satisfies UsageProfileResponse);
  }
}

/**
 * An honest empty body — no ledger yet, recording off, or a failed fit.
 *
 * `coverage` is present and zeroed rather than absent: the counters have no
 * nulls, so "nothing measured" is a row of measured zeros, and an optional
 * field here would push a null check into the card for a state that cannot
 * happen. `startProvable` is false because nothing was read to prove it.
 */
function zeroCoverage(): UsageCoverage {
  return {
    movedPct: 0, pricedPct: 0, mixedPct: 0, externalPct: 0,
    preLedgerPct: 0, missingPct: 0, partialPct: 0,
    recorderBreakHours: 0, startProvable: false
  };
}

/** Exported for the fail-open body's test only — the route is its one production caller. */
export function emptyRates(nowMs: number, recording: boolean, error?: true): UsageRatesResponse {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    recording,
    models: [],
    externalSharePct: null,
    coverage: zeroCoverage(),
    // `weeklyRecorded` is false because nothing was read to say otherwise — the
    // same reasoning as `startProvable`, and not a claim that the record is old.
    weeklyRecorded: false,
    weeklyCoverage: zeroCoverage(),
    weeklyExternalSharePct: null,
    boost: emptyBoost(),
    ...(error ? { error: true } : {})
  };
}


/**
 * Shape one `GET /api/usage/rates` body. Pure — no clock, no disk — so the
 * arithmetic and every honesty rule are testable (test/api-usage-rates.test.ts).
 *
 * One row per model that either owns an attributable interval **or** is
 * identified by the one-term joint fit, richest evidence first: the model you
 * actually use should not sit under a model you tried once. A model with
 * neither still gets no row at all — there is nothing to say about it yet, and
 * a row of nulls reads as a broken fit rather than as an absence of evidence.
 *
 * The fitted-only case is the one the second half of that rule exists for: a
 * model used only as a subagent beside a driver model never holds `DOMINANCE`
 * of a window, so the pooled rate has nothing for it and the card used to omit
 * it entirely. Its row's pooled numbers are legitimately all null with a `thin`
 * verdict and zeroed counters — honest, and not special-cased.
 */
export function shapeUsageRates(opts: {
  recording: boolean;
  samples: UsageSample[];
  ledger: LedgerLine[];
  nowMs: number;
  /**
   * When recording provably began, or null when the ledger cannot prove it.
   * A parameter rather than a read, so this stays pure.
   */
  ledgerStartMs: number | null;
}): UsageRatesResponse {
  const { recording, samples, ledger, nowMs, ledgerStartMs: startMs } = opts;
  if (!recording) return emptyRates(nowMs, false);

  const intervals = joinIntervals(samples, ledger, startMs);
  const models = new Set<string>();
  for (const interval of intervals) {
    if (typeof interval.kind === 'object') models.add(interval.kind.model);
  }

  // Both joint fits run over the same current window the pooled rows report,
  // so a row's three numbers never describe different spans.
  const cur = currentRange(nowMs);
  const splits = fitSplits(intervals, cur.sinceMs, cur.untilMs);
  const fitted = fitRates(intervals, cur.sinceMs, cur.untilMs);
  for (const model of fitted.keys()) models.add(model);

  // The weekly set, built once. Paired tick to tick rather than sample to
  // sample — see `joinWeeklyIntervals`, where the 6.5×–10.4× underestimate that
  // consecutive pairing produces is measured. Fitted over the *same* 3-day
  // window as everything above: this card refuses to put two figures spanning
  // different windows side by side.
  const weeklyIntervals = joinWeeklyIntervals(samples, ledger, startMs);
  const weeklyFitted = fitRates(weeklyIntervals, cur.sinceMs, cur.untilMs, WEEKLY_FLOORS);
  // A model priced only weekly still gets a row, exactly as a fitted-only model
  // already does.
  for (const interval of weeklyIntervals) {
    if (typeof interval.kind === 'object') models.add(interval.kind.model);
  }
  for (const model of weeklyFitted.keys()) models.add(model);

  const rows: ModelRateRow[] = [...models]
    .map((model) => {
      const split = splits.get(model);
      const fit = fitted.get(model);
      const drift = driftRow(intervals, model, nowMs);
      const weeklyPooled = rateFor(
        weeklyIntervals, model, cur.sinceMs, cur.untilMs, WEEKLY_FLOORS
      );
      const weeklyFit = weeklyFitted.get(model);
      // The evidence survives the refusal, as the 5-hour row's already does:
      // "10 windows over 2 days, still thin" and "nothing at all" are different
      // statements and the card says which.
      const weeklyEvidence = poolRate(weeklyIntervals, model, cur.sinceMs, cur.untilMs);
      return {
        ...drift,
        pctPerMWeighted: split?.pctPerMWeighted ?? null,
        pctPerRequest: split?.pctPerRequest ?? null,
        splitVerdict: split === undefined ? ('thin' as const) : ('fitted' as const),
        fittedWeightedPerPct: fit?.weightedPerPct ?? null,
        fitVerdict: fit === undefined ? ('thin' as const) : ('fitted' as const),
        // Against the pooled rate the row already publishes, so the number the
        // card compares is the number the card shows.
        fitDeviationPct: fitDeviation(fit?.weightedPerPct ?? null, drift.weightedPerPct),
        weekly: {
          weightedPerPct: weeklyPooled?.weightedPerPct ?? null,
          rawPerPct: weeklyPooled?.rawPerPct ?? null,
          fittedWeightedPerPct: weeklyFit?.weightedPerPct ?? null,
          verdict: weeklyPooled === null ? ('thin' as const) : ('fitted' as const),
          fitVerdict: weeklyFit === undefined ? ('thin' as const) : ('fitted' as const),
          intervals: weeklyEvidence?.intervals ?? 0,
          utilSum: weeklyEvidence?.utilSum ?? 0,
          days: weeklyEvidence?.days ?? 0
        },
        // The days the two figures above were pooled from, judged against the
        // same baseline the badge is — so the cells and the verdict cannot
        // disagree about what a day was compared to.
        daily: dailyRates(intervals, model, nowMs, startMs, drift.baselineWeightedPerPct)
      };
    })
    // On the **5-hour** `utilSum`, unchanged: a weekly-only model sorts last,
    // as a fitted-only model already does.
    .sort((a, b) => b.utilSum - a.utilSum || a.model.localeCompare(b.model));

  // Over the whole fitted horizon, not just the trailing window: it describes
  // how much of everything behind these numbers had to be thrown away.
  const share = externalShare(intervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);

  // Deliberately the same horizon as `externalSharePct` above: two disclosure
  // figures on one card that quietly spanned different windows would be a
  // defect, not a nuance.
  const buckets = coverageBreakdown(intervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);
  const breakMs = ledgerBreakMs(ledger, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);

  // Same horizon again for the weekly disclosure figures, for the same reason.
  const weeklyBuckets = coverageBreakdown(
    weeklyIntervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY
  );
  const weeklyShare = externalShare(
    weeklyIntervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY
  );

  return {
    generatedAt: new Date(nowMs).toISOString(),
    recording: true,
    models: rows,
    externalSharePct: share === null ? null : share * 100,
    coverage: {
      movedPct: buckets.moved,
      pricedPct: buckets.priced,
      mixedPct: buckets.mixed,
      externalPct: buckets.external,
      preLedgerPct: buckets.preLedger,
      missingPct: buckets.gap,
      partialPct: buckets.partial,
      recorderBreakHours: breakMs / 3_600_000,
      startProvable: startMs !== null
    },
    // Read off the samples, not the intervals: a record that carries weekly
    // readings whose counter simply never moved yields no intervals at all, and
    // that is a different state from a record written before the field existed.
    weeklyRecorded: samples.some((sample) => sample.week !== undefined),
    weeklyCoverage: {
      movedPct: weeklyBuckets.moved,
      pricedPct: weeklyBuckets.priced,
      mixedPct: weeklyBuckets.mixed,
      externalPct: weeklyBuckets.external,
      preLedgerPct: weeklyBuckets.preLedger,
      missingPct: weeklyBuckets.gap,
      partialPct: weeklyBuckets.partial,
      recorderBreakHours: breakMs / 3_600_000,
      startProvable: startMs !== null
    },
    weeklyExternalSharePct: weeklyShare === null ? null : weeklyShare * 100,
    // Off the 5-hour intervals already built above — no second join, no second read.
    boost: detectBoost(intervals, nowMs)
  };
}

/**
 * `GET /api/account` — who the CLI is signed in as, plus the two rate windows.
 *
 * The header account chip sits in the shell above every section, so it cannot
 * ride `/api/sessions`: that snapshot is a full transcript scan, polled every
 * 3s and only while the Sessions section is mounted. This body is two cached
 * reads — the memoised `~/.claude.json` profile and the same 60s usage cache
 * `serveSessions` attaches — so the client can poll it slowly from anywhere.
 *
 * `usage`/`usageStatus` are gated on `SHOW_USAGE` and absent when it is off,
 * exactly as they are on the sessions snapshot; the profile is not, because a
 * name is not a usage number and hiding it would leave the chip nameless for a
 * reason the reader could not guess.
 *
 * Fails open to `{ profile: null }` rather than a 500: this is a disclosure
 * view, and an empty one is better than a torn one.
 *
 * `homeDir` is injectable so a test can point the profile reader at a fixture.
 */
export function serveAccount(config: Config, res: ServerResponse, homeDir?: string): void {
  try {
    const profile = readAccountProfile(homeDir);
    if (!config.showUsage) return sendJson(res, 200, { profile });
    const u = getCachedUsageState();
    sendJson(res, 200, { profile, usage: u.usage, usageStatus: u.status });
  } catch {
    sendJson(res, 200, { profile: null });
  }
}

/** `GET /api/releases` — the dashboard's own release history; always 200, the empty shape when there is nothing to read (lib/releases.ts). */
export async function serveReleases(res: ServerResponse): Promise<void> {
  sendJson(res, 200, await releasesPayload());
}

/**
 * `GET /api/usage/rates` — what a percent of the 5-hour window costs, per model.
 *
 * Read-only and unpolled: it reads two files and does arithmetic, and the
 * numbers move on a scale of days. Fails open to an empty, honest body rather
 * than a 500 — the same posture as `serveUsageProfile`, and for the same
 * reason: this is a disclosure view, and a torn one is worse than an empty one.
 *
 * `dir` is injectable so a test can point all three readers at a fixture;
 * production omits it and they all resolve from the repo root.
 */
export function serveUsageRates(res: ServerResponse, dir?: string): void {
  const now = Date.now();
  try {
    const recording = getSettings().recordUsageHistory;
    if (!recording) return sendJson(res, 200, emptyRates(now, false));
    sendJson(res, 200, shapeUsageRates({
      recording,
      samples: readRecentSamples(dir, RATES_HISTORY_BYTES),
      ledger: readLedgerSince(now - BASELINE_MS, dir),
      ledgerStartMs: ledgerStartMs(dir),
      nowMs: now
    }));
  } catch {
    sendJson(res, 200, emptyRates(now, false, true));
  }
}

/** `days` as `GET /api/usage/history` accepts it: digits only, clamped to [1, 365]; missing or anything else is 7. */
function historyDays(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 7;
  return Math.min(365, Math.max(1, Number(raw)));
}

/**
 * `GET /api/usage/history?days=N` — recorded 5-hour and weekly utilization over the last N days, downsampled, with recording gaps.
 *
 * Served whenever the log has data, recording on or off: switching recording off stops new samples, it does not hide the past, and `recording`
 * tells the view why the line stops. Fails open to a 200 with empty series and one gap over the range — the same posture as `serveUsageRates`.
 * `dir` and `nowMs` are injectable for tests.
 */
export function serveUsageHistory(res: ServerResponse, query: URLSearchParams, dir?: string, nowMs: number = Date.now()): void {
  const days = historyDays(query.get('days'));
  const sinceMs = nowMs - days * 86_400_000;
  const head = { days, sinceT: sinceMs, nowT: nowMs };
  try {
    const recording = getSettings().recordUsageHistory;
    const series = buildUsageHistory(readSamplesSince(sinceMs, dir), { sinceMs, nowMs });
    const body: UsageHistoryResponse = { recording, ...head, ...series };
    sendJson(res, 200, body);
  } catch {
    const body: UsageHistoryResponse = {
      recording: false, ...head, bucketMs: 60_000, fiveHour: [], weekly: [], gaps: [{ fromT: sinceMs, toT: nowMs }], error: true
    };
    sendJson(res, 200, body);
  }
}

/**
 * `POST /api/settings` — change them from the Settings page. A gate-only write,
 * like the other config writes; 400 rather than a silent no-op when the body
 * carries nothing usable, so the UI never shows a value the server refused.
 */
export async function serveSettingsWrite(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req);
  const next = setSettings(body);
  if (!next) {
    return sendBadBody(res, {
      error: 'expected {idleSecs?: number, answerSecs?: number, notify?: NotifyPolicy, recordUsageHistory?: boolean, gitFetchSecs?: 0|30|60|120|300|600, trustTailnet?: boolean}'
    });
  }
  sendJson(res, 200, settingsBody(config, next));
}

/**
 * `POST /api/remote-answer` — flip the toggle from the dashboard. 409 when
 * `REMOTE_ANSWER=false` has disabled the feature outright (a UI toggle must not
 * silently override the config kill switch).
 */
export async function serveRemoteAnswerToggle(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean') return sendBadBody(res, { error: 'expected {enabled: boolean}' });
  const state = setEnabled(config, body.enabled);
  if (!state) return sendJson(res, 409, { error: 'disabled by REMOTE_ANSWER=false' });
  // Switching off releases the waits we already hold — their terminal dialogs
  // appear within a second instead of sitting out the full window. One switch,
  // both stores: a held plan is as remote as a held question.
  const released = body.enabled ? 0 : dismissAll() + dismissAllPlans() + dismissAllMessages();
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
  if (refuseWrite(config, req, res)) return;

  const body = await readJsonBody(req) as
    { sessionId?: unknown; toolInput?: unknown; timeoutMs?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

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
  if (refuseWrite(config, req, res)) return;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const body = await readJsonBody(req);
  if (!body) return sendBadBody(res, { error: 'bad body' });

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
  if (refuseWrite(config, req, res)) return;

  const body = await readJsonBody(req) as
    { sessionId?: unknown; toolInput?: unknown; timeoutMs?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

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

/** `owner/repo` of a PR URL on any host; null when the URL has no `/<owner>/<repo>/pull/<n>` shape. */
const ANY_PR_RE = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/;

/** `GET /api/sessions/:id/pr` — the newest PR this session created, with its live `gh` state or the reason there is none. */
export async function serveSessionPr(id: string, res: ServerResponse): Promise<void> {
  const fail = (code: number): void => sendJson(res, code, { id, pr: null, error: true } satisfies SessionPrResponse);
  if (!ID_RE.test(id)) return fail(400);

  try {
    const ref = findTranscript(projectsRoot(), id);
    const detected = ref ? readSessionPr(ref.file) : null;
    if (!detected) return sendJson(res, 200, { id, pr: null } satisfies SessionPrResponse);

    const { live, unavailable } = await readPrStatus(detected.url, detected.cwd);
    const repo = GH_PR_RE.exec(detected.url)?.[1] ?? ANY_PR_RE.exec(detected.url)?.[1] ?? null;
    const pr: SessionPrInfo = { url: detected.url, number: detected.number, repo, title: live?.title ?? detected.title, live, unavailable };
    sendJson(res, 200, { id, pr } satisfies SessionPrResponse);
  } catch (e) {
    console.error('[dashboard] session pr failed:', (e as Error).message);
    fail(500);
  }
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
  if (refuseWrite(config, req, res)) return;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const body = await readJsonBody(req);
  if (!body) return sendBadBody(res, { error: 'bad body' });

  switch (answerPlan(id, body)) {
    case 'ok': return sendJson(res, 200, { ok: true });
    case 'not-found': return sendJson(res, 404, { error: 'no plan is waiting' });
    case 'mismatch': return sendJson(res, 409, { error: 'that plan is no longer the one waiting' });
    default: return sendJson(res, 400, { error: 'bad verdict' });
  }
}

/**
 * `POST /api/messages/wait` — a session's Stop hook reports a finished turn and
 * holds here for a follow-up. Held exactly like the question wait; any non-200
 * (and any non-`answered` result) makes the hook exit 0, so the session stops
 * exactly as it did before the feature existed.
 *
 * Deliberately NO `sessionExists` check, unlike the question/plan waits: a Stop
 * hook fires as the turn ends, which is exactly when the transcript may not yet
 * be flushed for the scan to see (same reasoning as `serveNotifyEvent`). The id
 * is still shape-checked and never joined into a path — the store is RAM-keyed.
 */
export async function serveMessageWait(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (refuseWrite(config, req, res)) return;

  const body = await readJsonBody(req) as
    { sessionId?: unknown; timeoutMs?: unknown; permissionMode?: unknown; stopHookActive?: unknown; headless?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });
  // Backstop for a Stop hook installed before CLAUDE_DASHBOARD_REFRESH: the token-renewal turn is never held and never pushed (#178). `dismissed`, not an
  // error — any non-`answered` 200 makes the hook exit 0, while a non-2xx sends it to `notify_fallback` for a second, pointless round trip.
  if (isRefreshSession(sessionId)) return sendJson(res, 200, { status: 'dismissed' } satisfies MessageWaitResult);

  let messageId = '';
  res.on('close', () => { if (messageId) cancelMessage(sessionId, messageId); });
  // Strictly `=== true`, same rule as spawn's `remoteControl`: anything else
  // fails soft to the terminal-backed default, and a caller "lying" headless
  // only opts its own hold out of the idle release — the deadline still caps it.
  messageId = registerMessage(sessionId, clampTimeout(body.timeoutMs), (result: MessageWaitResult) => {
    if (res.writableEnded) return;
    sendJson(res, 200, result);
  }, body.headless === true);
  if (res.destroyed) cancelMessage(sessionId, messageId);

  // Mid-conversation stops (stop_hook_active) don't re-push — you are already
  // in the drawer typing. First stops do, with a phrase that says the window is
  // open; the user's per-event `stop` switch keeps governing both.
  if (body.stopHookActive !== true) {
    maybeSend(config, 'stop', {
      sessionId,
      permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
      phrase: 'finished — reply window open'
    });
  }
}

/** `GET /api/sessions/:id/message` — the reply window this session holds, if any. */
export function serveSessionMessage(id: string, res: ServerResponse): void {
  if (!ID_RE.test(id)) {
    const body: SessionMessage = { id, pending: null, error: true };
    return sendJson(res, 400, body);
  }
  sendJson(res, 200, { id, pending: getPendingMessage(id) } satisfies SessionMessage);
}

/**
 * `POST /api/sessions/:id/message-answer` — deliver the follow-up
 * (`{messageId, text}`) or release the hold (`{messageId, dismiss: true}`).
 * 404 means the window is already over: expired, released, or the hook is gone.
 */
export async function serveSessionMessageAnswer(
  config: Config, id: string, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!config.remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (refuseWrite(config, req, res)) return;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const body = await readJsonBody(req);
  if (!body) return sendBadBody(res, { error: 'bad body' });

  switch (answerMessage(id, body)) {
    case 'ok': return sendJson(res, 200, { ok: true });
    case 'not-found': return sendJson(res, 404, { error: 'no reply window is open' });
    case 'mismatch': return sendJson(res, 409, { error: 'that window is no longer the one open' });
    default: return sendJson(res, 400, { error: 'bad message' });
  }
}

/**
 * `POST /api/permissions/notify` — the PermissionRequest hook (or the older
 * Notification one) reporting that a session is showing an interactive
 * permission dialog. Body
 * `{sessionId, message?}`; the store keeps only the id and the arrival time.
 *
 * Write-shaped but not a control path: the flag decorates a row, and nothing
 * can answer the dialog remotely. Still behind the write gate like the other POSTs, since
 * it can otherwise be used to light up rows from anywhere on the LAN. The hook
 * ignores the response entirely — every failure here is invisible to the CLI.
 */
export async function servePermissionNotify(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (refuseWrite(config, req, res)) return;

  const body = await readJsonBody(req) as
    { sessionId?: unknown; message?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });
  if (!sessionExists(sessionId)) return sendJson(res, 404, { error: 'unknown session' });

  // Two hook events report one dialog (`PermissionRequest`, then `Notification`
  // ~6s later). The flag is idempotent, a push is not, so the store's own
  // "is this a new dialog" answer is what gates the buzz. Same shape as the
  // `stopHookActive` suppression on the message-wait route: the route decides,
  // `shouldNotify` stays a pure policy predicate.
  const freshDialog = notifyPermission(sessionId, body.message);
  if (freshDialog) {
    maybeSend(config, 'permission', {
      sessionId,
      permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
    });
  }
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
  if (refuseWrite(config, req, res)) return;

  const body = await readJsonBody(req) as
    { sessionId?: unknown; event?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });

  const event = body.event;
  if (event !== 'question' && event !== 'stop' && event !== 'permission' && event !== 'plan') {
    return sendJson(res, 400, { error: 'bad event' });
  }
  // The token-renewal turn is plumbing nobody started — no event from it is worth a push (#178). Same backstop as `serveMessageWait`.
  if (isRefreshSession(sessionId)) return sendJson(res, 200, { ok: true });

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
  if (refuseWrite(config, req, res)) return;
  sendJson(res, 200, { outcome: await sendTest(config) });
}

/* -------------------------------------------------- spawn endpoints */

/**
 * `POST /api/spawn` — start a new headless `claude -p` session in an existing
 * recent or pinned project.
 *
 * Gated on the remote-answer toggle exactly like `serveTranscribe` above, and
 * for the stronger version of its reason: spawn writes a whole new session on
 * this machine. The pill is the app's only *runtime* kill switch (`CLAUDE_BIN`
 * is restart-scoped), so a switch that silently excluded the widest session write path
 * would be worse than none — the user infers coverage. It is not an auth
 * boundary: `REMOTE_ANSWER` defaults to true and whoever can flip the pill off
 * can flip it back on. `HealthResponse.spawnAvailable` stays a pure capability
 * probe regardless, the same split `transcribe` uses on that payload.
 *
 * Check order, and the one part of it that is *not* about leaking less: the
 * probe runs before `refuseWrite`, unlike `serveTranscribe` above, which documents
 * the opposite order for itself. That divergence is harmless here rather than
 * principled — `GET /api/health` already publishes `spawnAvailable`
 * unauthenticated and already calls the same memoised `probeSpawn`, so
 * probe-first through this route reveals nothing new and spawns no extra
 * process. Cross-referenced in both directions on purpose: neither ordering
 * should be "corrected" to match the other without reading this paragraph.
 * From there the order does earn itself — who's asking, then how many launches
 * are already in flight (before a body is read, the same pre-buffer refusal
 * `serveTranscribe` does), then whether the request is usable
 * (`parseSpawnRequest`, pure, which also decides fresh-vs-resume), then the
 * filesystem step for the chosen shape.
 *
 * Neither `body.project` nor `body.resume` ever reaches the filesystem by
 * being joined into a path — the former resolves through `resolveProject`'s
 * membership check against the enumerated recent-or-pinned project list (the same
 * reasoning `serveConfigsProject` documents for its `dirName` query param),
 * the latter through an exact-id match against the enumerated transcripts.
 * Resume additionally requires the target to be a `dashboard`-surface
 * (`sdk-cli`) session that is not still running. Three checks answer that, and
 * none of them covers the whole set: a held question/plan/reply socket, the
 * launch store (`hasLiveChild` — exact, but only for children *this* process
 * spawned), and a `ps` argv scan (`liveSessionIds` — inexact, but the only one
 * that can see a session started from a terminal, by a second dashboard, or
 * before the last restart). See docs/subsystems/spawn.md.
 */
export async function serveSpawn(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!probeSpawn(config)) return sendJson(res, 404, { error: 'spawn unavailable' });
  if (refuseWrite(config, req, res)) return;
  // The accident rail (see MAX_LAUNCHING in server/lib/spawn.ts): N POSTs would
  // otherwise be N live `claude` processes on the account's real quota. Counted
  // before the body is read, like transcribe's `isTranscribing()` peek — and
  // `listLaunching()` is also what expires stale entries, so a burst that has
  // already aged out doesn't hold the door shut. Only `'launching'` rows count:
  // a `failed` one lingers for FAIL_TTL_MS (5 min) so the UI can explain
  // itself, holds no process, and must not lock the user out of launching.
  if (listLaunching().filter(e => e.state === 'launching').length >= MAX_LAUNCHING) {
    return sendJson(res, 429, { error: 'too many launches in flight' });
  }

  const body = await readJsonBody(req) as Partial<SpawnRequest> | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

  // Parse before any filesystem work — it is pure and decides which of the two
  // launch shapes this is (fresh vs resume). Fresh requests therefore see
  // parse errors before `unknown project`, a deliberate reordering.
  const parsed = parseSpawnRequest(body, config.spawnMaxPermission);
  if (!parsed.ok) return sendBadBody(res, { error: parsed.error });

  // resolveProject / the transcript hunt read disk and launch() spawns a
  // process — all can throw on an unexpected failure, and this handler is
  // void-dispatched from an async function in index.ts, so an uncaught throw
  // here would be an unhandled rejection (process death) rather than a 500.
  let sessionId: string;
  try {
    if (parsed.resumeId) {
      const rid = parsed.resumeId;
      // Membership check against the enumerated transcripts, same posture as
      // resolveProject below: the id never becomes a path by joining.
      const t = findTranscript(projectsRoot(), rid);
      if (!t) return sendJson(res, 400, { error: 'unknown session' });
      const tr = readTranscript(t.file);
      // Only headless (`sdk-cli` → the `dashboard` pill) sessions: a terminal
      // session is terminal-owned, and resuming one here could race a still-
      // open interactive session on the same transcript.
      if (!tr || sessionSurface(tr.entrypoint) !== 'dashboard') {
        return sendJson(res, 400, { error: 'only dashboard sessions can be resumed' });
      }
      if (!tr.cwd) return sendJson(res, 400, { error: 'session has no working directory' });
      // A held question, plan, or reply window means the process is alive —
      // resuming now would put a second writer on the same session.
      if (getPending(rid) || getPendingPlan(rid) || getPendingMessage(rid)) {
        return sendJson(res, 409, { error: 'session is still running' });
      }
      // A held socket is only *one* way to be alive. A session this server
      // spawned can be mid-tool-call, or lingering after its turn (measured at
      // 90s+), holding nothing at all — and the row shows `incomplete`, which
      // the resume composer offers. Launching then would put a second `claude`
      // on one transcript AND replace the live entry in the store, dropping the
      // first child's kill handle. The store knows, so ask it.
      if (hasLiveChild(rid)) {
        return sendJson(res, 409, { error: 'session is still running' });
      }
      // And the store can only answer for children *this* process spawned. A
      // session started from a terminal, by a second dashboard, or before the
      // last restart still reads `dashboard` and still offers resume, so the
      // fallback is the argv itself: `--session-id` / `--resume` carry the id.
      // Ordered second because the store is free and exact while this costs a
      // `ps`. A `null` probe means "could not answer" — never a refusal.
      const live = liveSessionIds();
      if (live?.has(rid)) {
        return sendJson(res, 409, { error: 'session is still running' });
      }
      // `'launching'` only, as at the cap above: a `failed` row for this id lingers
      // FAIL_TTL_MS for display, holds no process, and must not refuse a retry.
      if (listLaunching().some(e => e.sessionId === rid && e.state === 'launching')) {
        return sendJson(res, 409, { error: 'already resuming' });
      }
      const ref = { dirName: t.dirName, name: nodePath.basename(tr.cwd), path: tr.cwd, lastActiveMs: t.mtimeMs };
      // `claude -p --resume` with no `--effort` runs at the CLI's own default (medium on 2.1.295 and 2.1.303, read off this machine's transcripts 2026-10-25), not the effort the session ran at, so a
      // follow-up from the resume composer used to drop a high-effort session to medium mid-task. Carry the transcript's own value unless the
      // request named one.
      const recorded = parsed.input.effort ? null : lastSessionEffort(t.file);
      const effort = recorded && (EFFORTS as readonly string[]).includes(recorded) ? recorded : parsed.input.effort;
      sessionId = launch(config, ref, { ...parsed.input, effort }, rid);
    } else {
      const projectName = typeof body.project === 'string' ? body.project : '';
      const ref = resolveProject(config, projectName, pinOptions());
      // Named, but bounded: the body cap is 64KB, and every other rejection in
      // this file answers with a fixed string.
      if (!ref) return sendJson(res, 400, { error: `unknown project: ${projectName.slice(0, 60)}` });

      sessionId = launch(config, ref, parsed.input);
    }
  } catch (e) {
    console.error('[dashboard] spawn failed:', (e as Error).message);
    return sendJson(res, 500, { error: 'spawn failed' });
  }
  sendJson(res, 200, { sessionId } satisfies SpawnResponse);
}

/**
 * `POST /api/spawn/:id/stop` — SIGTERM a still-`launching` entry's child and
 * drop it from the store immediately (see `stopSession`'s own doc comment for
 * why a stopped launch can't be told apart from a crashed one downstream).
 *
 * Kept, not folded into {@link serveSessionStop}: this route is documented and
 * may already be scripted against. The two now share one store operation, which
 * is what "two endpoints behind one button is the wrong seam" actually asked
 * for — the button only ever calls the newer route.
 *
 * Toggle-gated like `serveSpawn`, so the pill covers the whole feature rather
 * than half of it. Deliberately **not** `async`: it awaits nothing (no body to
 * read — the id is in the path), and this handler is `void`-dispatched from
 * `index.ts`, so returning a promise would put it in the unhandled-rejection
 * class for no benefit. `serveSessionQuestion`/`serveSessionPlan` are plain
 * sync for the same reason.
 *
 * ⚠️ The child's pid lives only in this process's RAM (the store in
 * `server/lib/spawn.ts`), so after a server restart this always 404s — the
 * entry is gone even though the real process may still be running. Killing it
 * at that point is a terminal job (`kill <pid>`), not something this endpoint
 * can reach any more.
 */
export function serveSpawnStop(
  config: Config, id: string, req: IncomingMessage, res: ServerResponse
): void {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (refuseWrite(config, req, res)) return;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
  switch (stopSession(id)) {
    case 'not-found': return sendJson(res, 404, { error: 'no live launch' });
    // A launch inside its pre-adoption window is killed outright, which is what
    // this route has always answered. An id that has since become a running
    // session reaches the graceful path instead and honestly says so, rather
    // than claiming `stopped` for a SIGTERM that has not landed yet.
    case 'stopped': return sendJson(res, 200, { stopped: true });
    default: return sendJson(res, 200, { stopping: true });
  }
}

/**
 * `POST /api/sessions/:id/stop` — stop a session this dashboard spawned, at any
 * point in its life. The button on the row only ever calls this one; the older
 * `/api/spawn/:id/stop` above stays for the documented pre-adoption case and now
 * shares its implementation, so there are two routes but one behaviour.
 *
 * Body is optional and usually absent — the common request is a bare POST — so
 * an empty body means "graceful stop", not 400. Only a body that is present and
 * unparseable is refused. `force` is honoured on a strict `=== true`, the same
 * rule `remoteControl` and the dismiss flag follow; anything else (including the
 * string `"true"`) routes to the graceful path, because a coerced truthy value
 * is not evidence the caller meant to skip the grace window and SIGKILL.
 *
 * Async, unlike `serveSpawnStop`, purely because it reads that body; the guard
 * order is otherwise identical.
 */
export async function serveSessionStop(
  config: Config, id: string, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (refuseWrite(config, req, res)) return;
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  // `readJsonBody` collapses "empty" and "malformed" into the same null, and
  // those must not answer the same here — so read the raw bytes and branch.
  const raw = await readBody(req, BODY_CAP);
  if (!raw.ok) return sendBadBody(res, { error: 'bad body' });
  let force = false;
  if (raw.bytes.length > 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.bytes.toString('utf8')); }
    catch { return sendBadBody(res, { error: 'bad body' }); }
    force = (parsed as { force?: unknown } | null)?.force === true;
  }

  switch (force ? forceStopSession(id) : stopSession(id)) {
    case 'not-found': return sendJson(res, 404, { error: 'no live session' });
    case 'stopped': return sendJson(res, 200, { stopped: true });
    default: return sendJson(res, 200, { stopping: true });
  }
}

/* -------------------------------------------------- configs endpoints */

/**
 * One request to the Lookout hub routes. Resolves `false` when the hub does not own the path, so the caller falls through to its own table. A POST body
 * that is not JSON (or empty, or over the cap) reaches the hub as `undefined`; no action is declared, so every POST path answers 404 regardless.
 */
export async function serveHub(hub: HubHandler, u: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = req.method === 'POST' ? ((await readJsonBody(req)) ?? undefined) : undefined;
  const reply = await hub.handle({ method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, body });
  if (reply === null) return false;
  sendJson(res, reply.status, reply.json);
  return true;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function emptyScope(scope: 'global' | 'project', root = ''): ScopeConfig {
  return { scope, root, skills: [], agents: [], commands: [], rules: [], hooks: [], memory: [], settings: [], plugins: [], mcpServers: [] };
}

/**
 * `GET /api/configs` — the global scope (incl. plugins) + recent and pinned projects.
 * Fetched on section open, not polled: config changes on the order of days.
 */
export async function serveConfigsIndex(config: Config, res: ServerResponse): Promise<void> {
  let data: ManagementIndex;
  try {
    const [global, projects] = await Promise.all([
      readGlobalScope(),
      Promise.resolve(listRecentProjects(config, { archivedIds: archivedSessionIds(), ...pinOptions() }))
    ]);
    data = { generatedAt: new Date().toISOString(), global, projects };
  } catch (e) {
    console.error('[dashboard] configs index failed:', (e as Error).message);
    data = { error: true, generatedAt: new Date().toISOString(), global: emptyScope('global', claudeHome()), projects: [] };
  }
  sendJson(res, 200, data);
}

/**
 * `GET /api/configs/project?dir=<dirName>` — one project's scope. The
 * dirName is resolved against the enumerated recent-or-pinned project list, never
 * joined into a path (same philosophy as serveSessionDetail).
 */
export async function serveConfigsProject(config: Config, dirName: string, res: ServerResponse): Promise<void> {
  if (!ID_RE.test(dirName)) return sendJson(res, 400, { ...emptyScope('project'), error: true });
  try {
    const ref = resolveProject(config, dirName, pinOptions());
    if (!ref) return sendJson(res, 404, { ...emptyScope('project'), error: true });
    sendJson(res, 200, await readProjectScope(ref.path, ref.dirName));
  } catch (e) {
    console.error('[dashboard] configs project failed:', (e as Error).message);
    sendJson(res, 500, { ...emptyScope('project'), error: true });
  }
}

/**
 * `GET /api/configs/file?path=<abs>` — one enumerated file's content.
 * 400 malformed path, 403 not in the servable set, 404 vanished on disk.
 */
export async function serveConfigsFile(config: Config, rawPath: string, res: ServerResponse): Promise<void> {
  const p = rawPath;
  const fail = (code: number) => sendJson(res, code, { path: p, content: '', size: 0, truncated: false, error: true });
  if (!p || !p.startsWith('/') || p.includes('..')) return fail(400);
  try {
    const allowed = await collectServablePaths(config, pinOptions());
    if (!allowed.has(p)) return fail(403);
    const file = await readServableFile(p, allowed);
    if (!file) return fail(404);
    sendJson(res, 200, file);
  } catch (e) {
    console.error('[dashboard] configs file failed:', (e as Error).message);
    fail(500);
  }
}

/* ------------------------------------------------------- pins endpoints */

/**
 * The stored pins, as the `ProjectsOptions` every project-list caller passes
 * (#161). Read per request — `settings.ts` caches it, so this costs nothing.
 */
function pinOptions(): { pinnedDirs: ReadonlySet<string> } {
  return { pinnedDirs: new Set(getPinnedProjects()) };
}

/**
 * A recent project Claude made for itself (a scratch workspace, a dir under
 * `~/.claude`) stays on the rail but is not offered here, the same rule
 * `listOlderProjects` applies. A pin already made there still lists under
 * `pinned` — that is where it can be removed.
 */
function pinsPayload(config: Config): PinsResponse {
  const options = { archivedIds: archivedSessionIds(), ...pinOptions() };
  const claudeRoots = defaultClaudeRoots();
  return {
    pinned: listPinRows(config, getPinnedProjects(), options),
    recent: listRecentProjects(config, options).filter(r => !r.pinned && !isClaudeOwned(r.path, claudeRoots)),
    older: listOlderProjects(config, options),
    home: nodePath.dirname(claudeHome())
  };
}

/** `GET /api/pins` — the stored pins plus the recent and older projects offered for pinning (#161). */
export function servePinsRead(config: Config, res: ServerResponse): void {
  try {
    sendJson(res, 200, pinsPayload(config));
  } catch (e) {
    console.error('[dashboard] pins read failed:', (e as Error).message);
    sendJson(res, 500, { error: 'pins read failed' });
  }
}

/**
 * `GET /api/git-stats` — the local git state of every pinned project (git-stats spec §3). No parameters and no method check, like the read routes beside it:
 * the repo paths come from the stored pins, never from the request. A repo that fails reports its own `error` state; only an unreadable pin list is a 500.
 * Every answer marks the Git view watched, which is what lets the fetch timer run (git-fetch spec D2).
 */
export async function serveGitStats(config: Config, res: ServerResponse): Promise<void> {
  try {
    markGitWatched();
    sendJson(res, 200, await readGitStats(config));
  } catch (e) {
    console.error('[dashboard] git stats read failed:', (e as Error).message);
    sendJson(res, 500, { error: 'git stats read failed' });
  }
}

/**
 * `POST /api/git-fetch` — fetch every pinned repo's `origin` now and answer with the clock as the run leaves it (git-fetch spec §2). The method check is the
 * router's; the write gate is here, because this is the one route that makes git talk to the network. A run already in flight is joined, not doubled (D6).
 */
export async function serveGitFetch(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  try {
    markGitWatched();
    sendJson(res, 200, { fetch: await fetchAll(config) });
  } catch (e) {
    console.error('[dashboard] git fetch failed:', (e as Error).message);
    sendJson(res, 500, { error: 'git fetch failed' });
  }
}

/**
 * `POST /api/git-quick` — a fast-forward Pull or a Push of one pinned repo, no Claude session (quick pull/push spec §API). The body names a pin and an op,
 * never a path: the repo is the pin's own folder, read from the stored pin list exactly as `/api/git-stats` reads it. `fetch-running` and `busy` are 409,
 * since retrying in a moment is the answer to both; every other refusal is a 200 the client words.
 */
export async function serveGitQuick(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { dirName?: unknown; op?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.dirName !== 'string' || (body.op !== 'pull' && body.op !== 'push')) {
    return sendBadBody(res, { error: "expected {dirName: string, op: 'pull' | 'push'}" });
  }
  const { dirName, op } = body as GitQuickRequest;
  const rows = listPinRows(config, getPinnedProjects(), { archivedIds: archivedSessionIds(), ...pinOptions() });
  // Not `listed`: git-stats draws every pin with a path, a linked worktree's included, so the menu it feeds must reach git for the same set.
  const pin = rows.find(r => r.dirName === dirName && r.path !== null);
  if (!pin || pin.path === null) return sendJson(res, 404, { error: 'not a pinned project' });
  try {
    const answer = await runQuickOp({ name: pin.name, toplevel: pin.path }, op);
    sendJson(res, answer.refusal === 'fetch-running' || answer.refusal === 'busy' ? 409 : 200, answer);
  } catch (e) {
    console.error('[dashboard] git quick failed:', (e as Error).message);
    sendJson(res, 500, { error: 'git quick failed' });
  }
}

/**
 * `GET /api/codegraph` — the codegraph state of every pinned project, in pin order (codegraph-view spec §API). No method check, like `serveGitStats`: the
 * repo paths come from the stored pins, never from the request. The one parameter, `fresh=1` (Re-read status), skips the status cache; any other value is a
 * plain read. A repo that fails reads as its own `error` row; only an unreadable pin list is a 500.
 */
export async function serveCodegraph(config: Config, res: ServerResponse, fresh = false): Promise<void> {
  try {
    sendJson(res, 200, await readCodegraph(config, { fresh }));
  } catch (e) {
    console.error('[dashboard] codegraph read failed:', (e as Error).message);
    sendJson(res, 500, { error: 'codegraph read failed' });
  }
}

/** What the store's refusal means to the caller; the order they are checked in lives in `startCodegraphRun`. */
const CODEGRAPH_RUN_REFUSALS = {
  'not-pinned': [403, 'not a pinned project'],
  'not-indexed': [404, 'not indexed'],
  busy: [409, 'already running'],
} as const;

/**
 * `POST /api/codegraph/run` `{dirName, kind}` — start a Sync or Reindex on one pinned repo and answer at once (codegraph-view spec §API). The method check
 * is the router's. Refusals in order: the write gate, the body shape (checked here so a bad `kind` can never reach the CLI), then the store's own: not
 * pinned, not indexed, already running.
 */
export async function serveCodegraphRun(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { dirName?: unknown; kind?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.dirName !== 'string' || body.dirName === '' || (body.kind !== 'sync' && body.kind !== 'reindex')) {
    return sendBadBody(res, { error: "expected {dirName: string, kind: 'sync' | 'reindex'}" });
  }
  try {
    const result = await startCodegraphRun(config, body.dirName, body.kind);
    if (result === 'started') return sendJson(res, 200, { ok: true });
    const [status, error] = CODEGRAPH_RUN_REFUSALS[result];
    sendJson(res, status, { error });
  } catch (e) {
    console.error('[dashboard] codegraph run failed:', (e as Error).message);
    sendJson(res, 500, { error: 'codegraph run failed' });
  }
}

/**
 * The owner keeps `pins.json` current for the routine wrapper, which never calls the dashboard (spec §The job file, Pins on disk). Called here rather
 * than from `settings.ts`, which `management.ts` imports. The pin change already stands, so a failed snapshot is logged, not answered.
 */
function snapshotPins(config: Config): void {
  if (!isOwner()) return;
  try { writePinsSnapshot(config); } catch (e) { console.error('[dashboard] pins snapshot failed:', (e as Error).message); }
}

/**
 * `POST /api/pins` `{dirName, pinned}` — pin or unpin one project (#161).
 * A gate-only write, like `POST /api/settings`. A pin must name a dir the server
 * itself enumerated (older ∪ recent), compared as a string and never joined into
 * a path — a pinned dir becomes spawnable and its config servable, so this is
 * the gate. An unpin accepts any stored dir, so a dead pin can be removed.
 * Success answers with the fresh `GET /api/pins` payload.
 */
export async function servePinsWrite(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { dirName?: unknown; pinned?: unknown } | null;
  if (!body || typeof body.dirName !== 'string' || typeof body.pinned !== 'boolean') {
    return sendBadBody(res, { error: 'expected {dirName: string, pinned: boolean}' });
  }
  const { dirName, pinned } = body;
  if (pinned) {
    const options = { archivedIds: archivedSessionIds(), ...pinOptions() };
    const known = [...listRecentProjects(config, options), ...listOlderProjects(config, options)]
      .some(r => r.dirName === dirName);
    if (!known) return sendJson(res, 404, { error: 'no such project' });
  }
  if (setPinned(dirName, pinned) === null) return sendJson(res, 409, { error: 'pin limit reached' });
  snapshotPins(config);
  sendJson(res, 200, pinsPayload(config));
}

/**
 * `POST /api/pins/order` `{order}` — the whole pin list in its new order. Same token gate as `POST /api/pins`, but no membership check against the
 * enumerated projects: a permutation of the stored list cannot add a dir, which is the property that check protects. Anything but an exact permutation
 * is a 409, so a stale tab can neither drop nor resurrect a pin. Success answers with the fresh `GET /api/pins` payload.
 */
export async function servePinsOrder(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { order?: unknown } | null;
  if (!body || !Array.isArray(body.order) || !body.order.every(d => typeof d === 'string')) {
    return sendBadBody(res, { error: 'expected {order: string[]}' });
  }
  if (setPinOrder(body.order) === null) return sendJson(res, 409, { error: 'pins changed — reload' });
  snapshotPins(config);
  sendJson(res, 200, pinsPayload(config));
}

/**
 * `POST /api/open-folder` `{path}` — open a pinned project's folder in Finder on the server host (management redesign spec §6.3). The method check is the
 * router's. This launches a process on the host from a request that may come over LAN or the tailnet, so beyond the write gate the path must string-equal the
 * path of a pin listed now: nothing is joined or normalised, so the request can name only a folder the pin list already shows. The platform gate sits before
 * the pin read so a non-macOS host answers 501 without listing anything.
 */
export async function serveOpenFolder(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { path?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.path !== 'string' || body.path === '') {
    return sendBadBody(res, { error: 'expected {path: string}' });
  }
  const { path } = body;
  if (openFolderPlatform() !== 'darwin') return sendJson(res, 501, { error: 'open folder needs macOS' });
  // A pin's path is absolute; a relative or `-`-prefixed value never names one, so it is refused before the pin list is even read.
  if (!nodePath.isAbsolute(path)) return sendJson(res, 403, { error: 'not a pinned project' });
  const rows = listPinRows(config, getPinnedProjects(), { archivedIds: archivedSessionIds(), ...pinOptions() });
  if (!rows.some(r => r.listed === true && r.path === path)) return sendJson(res, 403, { error: 'not a pinned project' });
  try {
    await openFolder(path);
  } catch (e) {
    console.error(`[dashboard] open folder failed: ${(e as Error).message}`);
    return sendJson(res, 500, { error: 'open failed' });
  }
  sendJson(res, 200, { ok: true } satisfies OpenFolderResponse);
}

/* -------------------------------------------------- routines (docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md §HTTP) */

/** A job name from a URL or a body, checked before it reaches any path; the reserved names pass here and are the validator's to refuse. */
const JOB_NAME_RE = /^[a-z0-9-]+$/;
/** The wrapper takes `--only` as argv; a list longer than any pin set is refused rather than handed to a spawn. */
const ONLY_MAX = 200;
const ROUTINE_WINDOWS = [7, 30, 90] as const;
const RUN_OUTCOMES: ReadonlySet<string> = new Set(['running', 'ok', 'failed', 'lost', 'refused']);

/**
 * The checks every job-scoped routine write makes after the write gate: the name (400, nothing touched) and ownership (409 — only the owning server
 * writes job files, installs or runs, spec §Owning server). True when it has answered and the caller must return.
 */
function refuseRoutineWrite(res: ServerResponse, name?: string): boolean {
  if (name !== undefined && !JOB_NAME_RE.test(name)) { sendJson(res, 400, { error: 'bad name' }); return true; }
  if (!isOwner()) { sendJson(res, 409, { error: 'not-owner' }); return true; }
  return false;
}

/** The pins as the wrapper will see them in `pins.json`, for `checkPins`: the same rows `GET /api/pins` lists. */
function pinSnapshot(config: Config): PinSnapshot[] {
  return listPinRows(config, getPinnedProjects(), { archivedIds: archivedSessionIds(), ...pinOptions() })
    .map(r => ({ dirName: r.dirName, name: r.name, path: r.path, listed: r.listed }));
}

/** `parseJob` plus the ambiguous-pin check against the pins of this machine now — what PUT, POST and `/validate` all run. */
function validateRoutineText(config: Config, name: string, text: string): { job: RoutineJob | null; errors: JobError[] } {
  const parsed = parseJob(name, text);
  if (!parsed.job) return parsed;
  const pinErrors = checkPins(parsed.job, pinSnapshot(config));
  return pinErrors.length > 0 ? { job: null, errors: pinErrors } : parsed;
}

/** The drawer's one-line reading of a valid job: when, how, where. */
function routineSummary(job: RoutineJob): string {
  const cron = parseCron(job.cron);
  const when = cron.ok ? describeCron(cron.cron) : job.cron;
  const where = job.foreach === 'pinned' ? 'every pinned repo'
    : Array.isArray(job.foreach) ? `${job.foreach.length} repo${job.foreach.length === 1 ? '' : 's'}`
      : job.cwd ?? 'the routines folder\'s parent';
  return [when, job.run, where, job.machines.join(' + '), job.enabled || isManualCron(job.cron) ? null : 'paused'].filter(Boolean).join(' · ');
}

/** Whether the OS holds a job for `name`, read off a planned report. A bare report (not owner, no plugin, bad machine) knows nothing: false. */
export function installedFrom(report: ReconcileReport, name: string, desired: boolean): boolean {
  const planned = report.state !== 'not-owner' && report.state !== 'no-plugin' && report.state !== 'bad-machine'
    && !(report.state === 'failed' && report.changes.length === 0 && report.unchanged === 0);
  if (!planned) return false;
  const change = report.changes.find(c => c.name === name);
  if (!change) return desired;
  if (change.action === 'install') return false;
  if (change.action === 'pending') return change.why === 'running';
  return true;
}

function nextFire(job: RoutineJob, now: Date): string | null {
  const cron = parseCron(job.cron);
  return cron.ok ? nextAfter(cron.cron, now)?.toISOString() ?? null : null;
}

/** `GET /api/routines` — the ledger. Read-only and open to every peer; plans reconcile against the OS (no writes), and folds the log for pushes. */
export async function serveRoutines(config: Config, res: ServerResponse): Promise<void> {
  try {
    const machine = machineName(config).name;
    const dir = routineDirs(config).routines;
    const stored = readJobs(dir);
    const runs = runsReader(config).read();
    foldForPush(config, runs);
    const plan = await planReconcile(config);
    // The plan re-reads the OS on every poll; a failed apply's message would otherwise vanish behind the drift it left.
    const last = lastReconcile();
    const reconcile = plan.state === 'drift' && plan.error === null && last?.state === 'failed' ? { ...plan, error: last.error } : plan;
    const now = new Date();
    const jobs: RoutineJobRow[] = stored.map(s => {
      const onThisMachine = s.job?.machines.includes(machine) ?? false;
      const desired = s.job !== null && scheduled(s.job) && onThisMachine;
      return {
        ...s,
        onThisMachine,
        installed: installedFrom(reconcile, s.name, desired),
        nextAt: desired && s.job ? nextFire(s.job, now) : null,
        last: runs.find(r => r.job === s.name && r.state !== 'running') ?? null,
        running: runs.find(r => r.job === s.name && r.state === 'running') ?? null
      };
    });
    sendJson(res, 200, { machine, dir, owner: ownerStatus(), reconcile, jobs } satisfies RoutinesResponse);
  } catch (e) {
    console.error('[dashboard] routines read failed:', (e as Error).message);
    sendJson(res, 500, { error: 'routines read failed' });
  }
}

/**
 * `GET /api/routines/runs?days=30&job=&outcome=&runner=` — the folded runs of the window, newest first, and the stats. `days` outside 7 | 30 | 90 reads
 * as 30. `runner` is looked up in the job's file (a run carries none), so a run of a job whose file is gone is excluded once that filter is set.
 */
export function serveRoutineRuns(config: Config, params: URLSearchParams, res: ServerResponse): void {
  try {
    const rawDays = Number(params.get('days'));
    const days = ROUTINE_WINDOWS.find(d => d === rawDays) ?? 30;
    const job = params.get('job') || null;
    const outcome = params.get('outcome') || null;
    if (outcome !== null && !RUN_OUTCOMES.has(outcome)) return sendJson(res, 400, { error: 'bad outcome' });
    const runner = params.get('runner') || null;
    const all = runsReader(config).read();
    foldForPush(config, all);
    const runnerOf = new Map(readJobs(routineDirs(config).routines).map(s => [s.name, s.job?.run ?? null]));
    const scoped = all.filter(r => (job === null || r.job === job) && (runner === null || runnerOf.get(r.job) === runner));
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
    const runs = scoped.filter(r => {
      const t = Date.parse(r.startedAt);
      return Number.isFinite(t) && t >= from && (outcome === null || r.state === outcome);
    });
    sendJson(res, 200, { runs, stats: computeStats(scoped, days, now) } satisfies RoutineRunsResponse);
  } catch (e) {
    console.error('[dashboard] routine runs read failed:', (e as Error).message);
    sendJson(res, 500, { error: 'routine runs read failed' });
  }
}

/** `GET /api/routines/:name` — the raw file and its parse, for the editor. */
export function serveRoutineRead(config: Config, name: string, res: ServerResponse): void {
  if (!JOB_NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad name' });
  const stored = readJobs(routineDirs(config).routines).find(s => s.name === name);
  if (!stored) return sendJson(res, 404, { error: 'no such job' });
  sendJson(res, 200, stored satisfies RoutineFile);
}

/** `PUT /api/routines/:name` `{text}` — replace an existing job's file. Validated first; `422 {errors}` writes nothing. */
export async function serveRoutineWrite(config: Config, name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  if (refuseRoutineWrite(res, name)) return;
  const body = await readJsonBody(req) as { text?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') return sendBadBody(res, { error: 'expected {text: string}' });
  const dir = routineDirs(config).routines;
  if (!readJobs(dir).some(s => s.name === name)) return sendJson(res, 404, { error: 'no such job' });
  const { job, errors } = validateRoutineText(config, name, body.text);
  if (!job) return sendJson(res, 422, { errors });
  try {
    writeJob(dir, name, body.text, 'replace');
  } catch (e) {
    console.error('[dashboard] routine write failed:', (e as Error).message);
    return sendJson(res, 500, { error: 'write failed' });
  }
  sendJson(res, 200, { job, reconcile: await applyReconcile(config) });
}

/** `POST /api/routines` `{name, text}` — a new job: `409` when the file exists, else validated and written like PUT. */
export async function serveRoutineCreate(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { name?: unknown; text?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.name !== 'string' || typeof body.text !== 'string') {
    return sendBadBody(res, { error: 'expected {name: string, text: string}' });
  }
  const { name, text } = body;
  if (refuseRoutineWrite(res, name)) return;
  const dir = routineDirs(config).routines;
  if (readJobs(dir).some(s => s.name === name)) return sendJson(res, 409, { error: 'exists' });
  const { job, errors } = validateRoutineText(config, name, text);
  if (!job) return sendJson(res, 422, { errors });
  try {
    writeJob(dir, name, text, 'create');
  } catch (e) {
    if (e instanceof RoutineStoreError && e.code === 'exists') return sendJson(res, 409, { error: 'exists' });
    console.error('[dashboard] routine create failed:', (e as Error).message);
    return sendJson(res, 500, { error: 'write failed' });
  }
  sendJson(res, 200, { job, reconcile: await applyReconcile(config) });
}

/** `DELETE /api/routines/:name` — remove the file and reconcile; the run log keeps the job's rows. */
export async function serveRoutineDelete(config: Config, name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  if (refuseRoutineWrite(res, name)) return;
  let removed: boolean;
  try {
    removed = deleteJob(routineDirs(config).routines, name);
  } catch (e) {
    console.error('[dashboard] routine delete failed:', (e as Error).message);
    return sendJson(res, 500, { error: 'delete failed' });
  }
  if (!removed) return sendJson(res, 404, { error: 'no such job' });
  sendJson(res, 200, { reconcile: await applyReconcile(config) });
}

/** `PATCH /api/routines/:name` `{enabled}` — rewrite the `enabled:` line only (every other byte kept), then reconcile. */
export async function serveRoutinePatch(config: Config, name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  if (refuseRoutineWrite(res, name)) return;
  const body = await readJsonBody(req) as { enabled?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.enabled !== 'boolean') return sendBadBody(res, { error: 'expected {enabled: boolean}' });
  const dir = routineDirs(config).routines;
  const stored = readJobs(dir).find(s => s.name === name);
  if (!stored) return sendJson(res, 404, { error: 'no such job' });
  // An unparseable file has no trustworthy `enabled:` line to rewrite; the drawer fixes it through PUT.
  if (!stored.job) return sendJson(res, 422, { errors: stored.errors });
  const text = serializeEnabled(stored.text, body.enabled);
  try {
    writeJob(dir, name, text, 'replace');
  } catch (e) {
    console.error('[dashboard] routine toggle failed:', (e as Error).message);
    return sendJson(res, 500, { error: 'write failed' });
  }
  sendJson(res, 200, { job: parseJob(name, text).job, reconcile: await applyReconcile(config) });
}

/** `POST /api/routines/reconcile` `{apply?}` — the diff, applied when `apply` is true. The plugin sync script posts `{apply: true}`. */
export async function serveRoutineReconcile(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  if (refuseRoutineWrite(res)) return;
  const body = await readJsonBody(req) as { apply?: unknown } | null;
  try {
    sendJson(res, 200, body && typeof body === 'object' && body.apply === true ? await applyReconcile(config) : await planReconcile(config));
  } catch (e) {
    console.error('[dashboard] routine reconcile failed:', (e as Error).message);
    sendJson(res, 500, { error: 'reconcile failed' });
  }
}

/** `POST /api/routines/:name/run` `{only?: string[]}` — Run now (`routine-run.ts`); its answers map 1:1 onto HTTP. */
export async function serveRoutineRun(config: Config, name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  if (refuseRoutineWrite(res, name)) return;
  // Fail closed: a body that did not arrive whole, or did not parse, is refused rather than read as "no `only`", which would run every pin.
  const raw = await readBody(req, BODY_CAP);
  if (!raw.ok) return sendBadBody(res, { error: 'bad body' });
  let only: unknown;
  if (raw.bytes.length > 0) {
    let body: unknown;
    try { body = JSON.parse(raw.bytes.toString('utf8')); } catch { return sendBadBody(res, { error: 'bad body' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendBadBody(res, { error: 'bad body' });
    // No `only` key is a whole run; anything under the key, null included, is `runJob`'s to judge.
    only = 'only' in body ? (body as { only?: unknown }).only : undefined;
  }
  // `runJob` reads `[]` as every pin; over HTTP an empty selection is a caller bug, not a request for a whole run.
  if (Array.isArray(only) && (only.length === 0 || only.length > ONLY_MAX)) return sendJson(res, 400, { error: 'bad-only' });
  try {
    const result = await runJob(config, name, only);
    if (result.status === 202) return sendJson(res, 202, { run: result.run });
    if (result.status === 404) return sendJson(res, 404, { error: 'no such job' });
    sendJson(res, result.status, { error: result.error });
  } catch (e) {
    console.error('[dashboard] routine run failed:', (e as Error).message);
    sendJson(res, 500, { error: 'spawn-failed' });
  }
}

/** `POST /api/routines/:name/stop` — SIGTERM the job's live wrapper: `204`, or `409 not-running`. */
export async function serveRoutineStop(config: Config, name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  if (refuseRoutineWrite(res, name)) return;
  const result = stopJob(config, name);
  if (result.status === 204) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return void res.end();
  }
  sendJson(res, 409, { error: result.error });
}

/**
 * `POST /api/routines/reveal` `{name?}` — open the routines folder in Finder (macOS only, `501` elsewhere), with `<name>.md` selected when a name is sent.
 * The folder comes from config, never the request; a name must match the job-name rule before it is joined onto it, so it cannot climb out.
 */
export async function serveRoutineReveal(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (refuseWrite(config, req, res)) return;
  const body = await readJsonBody(req) as { name?: unknown } | null;
  const name = body && typeof body === 'object' ? body.name : undefined;
  if (name !== undefined && typeof name !== 'string') return sendBadBody(res, { error: 'expected {name?: string}' });
  if (refuseRoutineWrite(res, name)) return;
  if (openFolderPlatform() !== 'darwin') return sendJson(res, 501, { error: 'reveal needs macOS' });
  const dir = routineDirs(config).routines;
  if (!fs.existsSync(dir)) return sendJson(res, 404, { error: 'no routines folder' });
  const file = name === undefined ? null : nodePath.join(dir, `${name}.md`);
  if (file !== null && !fs.existsSync(file)) return sendJson(res, 404, { error: 'no such job' });
  try {
    await (file === null ? openFolder(dir) : revealFile(file));
  } catch (e) {
    console.error(`[dashboard] routines reveal failed: ${(e as Error).message}`);
    return sendJson(res, 500, { error: 'open failed' });
  }
  sendJson(res, 200, { ok: true });
}

/**
 * `POST /api/routines/validate` `{text, name?}` — what the drawer calls as the user types. Read-only, so outside the write gate: it parses and checks pins,
 * and touches no file. Without a `name` the file is judged under a neutral one, so the name rules stay the Name field's.
 */
export async function serveRoutineValidate(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as { text?: unknown; name?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.text !== 'string') return sendBadBody(res, { error: 'expected {text: string}' });
  const name = typeof body.name === 'string' ? body.name : 'untitled';
  const { job, errors } = validateRoutineText(config, name, body.text);
  sendJson(res, 200, { errors, summary: job ? routineSummary(job) : null } satisfies RoutineValidateResponse);
}

/**
 * `GET /api/sessions/:id/row` — one `Session` row for any transcript `findTranscript` resolves, whatever its age: a routine run's `session →` opens
 * the chat drawer with it. No lookback, the liveness set null (fail open), no wait sets, and none of the list's skips, so a run the list would hide
 * still opens. `404` only when no transcript exists.
 */
export function serveSessionRow(config: Config, id: string, res: ServerResponse): void {
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
  try {
    const ref = findTranscript(projectsRoot(), id);
    if (!ref) return sendJson(res, 404, { error: 'no such session' });
    const row = sessionFromRef(ref, {
      now: Date.now(), activeWindowMin: config.activeWindowMin, liveCwds: null,
      lessons: config.showAnalytics === false ? null : readSessionAnalyticsLog()
    });
    if (!row) return sendJson(res, 500, { error: 'transcript unreadable' });
    sendJson(res, 200, row satisfies Session);
  } catch (e) {
    console.error('[dashboard] session row failed:', (e as Error).message);
    sendJson(res, 500, { error: 'session row failed' });
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
