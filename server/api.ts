/**
 * api.ts — the `/api/sessions` endpoints. `serveSessions` writes the ranked
 * snapshot; `serveSessionDetail` writes one session's subagent activity. Both
 * fall back to a safe empty payload if the scan throws.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import nodePath from 'node:path';

import { scanSessions, lastMessageMs, listTranscripts, projectsRoot, sessionSurface } from './lib/scan.js';
import { archivedSessionIds } from './lib/archived.js';
import { readTranscript } from './lib/transcript.js';
import { readAgentsCached } from './lib/agents-cache.js';
import { getCachedUsageState } from './lib/usage.js';
import { deriveProfile, profileSnapshot, readRecentSamples } from './lib/usage-history.js';
import type { ProfileState, UsageSample } from './lib/usage-history.js';
import { ledgerStartMs, readLedgerSince } from './lib/usage-ledger.js';
import type { LedgerLine } from './lib/usage-ledger.js';
import {
  BASELINE_MS, coverageBreakdown, currentRange, driftRow, externalShare, fitSplits,
  joinIntervals, ledgerBreakMs
} from './lib/usage-rate.js';
import { HOURS_PER_WEEK, confidenceOf, localOffsetMinutes, walkForward } from './lib/usage-forecast.js';
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
import { getSettings, setSettings } from './lib/settings.js';
import { classifyOrigin } from './lib/origin.js';
import { extForMime, isTranscribing, probeTranscribe, transcribe } from './lib/transcribe.js';
import {
  MAX_LAUNCHING, adoptLaunched, launch, listLaunching, parseSpawnRequest, probeSpawn, stopLaunch
} from './lib/spawn.js';
import { staleEnvKeys, toPosInt, type Config } from './lib/config.js';
import type {
  AnalyticsResponse, ManagementIndex, MessageWaitResult, PlanWaitResult, ScopeConfig,
  SessionMessage, SessionPlan, SessionQuestion, SessionsResponse, SessionChat, SessionDetail, SpawnRequest,
  ModelRateRow, RateLimit, SpawnResponse, UsageProfileCell, UsageProfileResponse,
  UsageRatesResponse, WaitResult
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

export function serveSessions(baseConfig: Config, res: ServerResponse, params?: URLSearchParams): void {
  const config = scanOverrides(baseConfig, params);
  // Before the scan, not after: a wait the terminal already decided must not
  // colour this tick's row blue either.
  sweepTerminalDecisions();
  let data: SessionsResponse;
  try {
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
    data = scanSessions(config, {
      skipProcScan: config.skipProcScan,
      pendingIds: pendingSessionIds(),
      planIds: planSessionIds(),
      messageIds: messageSessionIds(),
      permissionWaits: permissionWaits(),
      archivedIds: archivedSessionIds()
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
 * collapsed here rather than re-branched at ten call sites.
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
 * Gated like the four write paths even though it writes no session state: it
 * spawns processes and writes files on this machine, which is firmly the write
 * side of the line this codebase draws. Token comes before the engine probe so
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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
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
 * Say once, on stderr, that a write was refused for its token.
 *
 * Silence here is what made backlog bug-6 cost twelve hours: the installer had
 * written no token file, every hook POST came back 403, and the hooks swallow
 * that (`curl -sf`, then `exit 0`). Nothing on any surface distinguished a
 * misconfigured token from a feature nobody had switched on.
 *
 * Method and path only. Never the expected token, the received header, or a
 * prefix of either — a log that carries the credential is a worse bug than the
 * one it diagnoses — and never the query string, which is the one part of a URL
 * a caller might have put a secret in.
 *
 * Throttled per path because a held `stop` hook retries: an unthrottled line
 * would bury the output it is supposed to draw attention to.
 */
function logRejectedWrite(req: IncomingMessage): void {
  const key = `${req.method || 'GET'} ${(req.url || '').split('?')[0]}`;
  const now = Date.now();
  const last = rejectLogged.get(key);
  if (last !== undefined && now - last < REJECT_LOG_WINDOW_MS) return;
  // Paths carry session ids, so the key space is unbounded over a long run.
  if (rejectLogged.size >= 256) rejectLogged.clear();
  rejectLogged.set(key, now);
  console.error(`[dashboard] rejected write: ${key} (bad or missing token)`);
}

/**
 * Bearer check for the two write endpoints. An unset ANSWER_TOKEN leaves them
 * open — the same posture as every read endpoint here.
 */
function tokenOk(config: Config, req: IncomingMessage): boolean {
  if (!config.answerToken) return true;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header === `Bearer ${config.answerToken}`) return true;
  logRejectedWrite(req);
  return false;
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
    origin: classifyOrigin(req?.socket?.remoteAddress, req?.headers),
    tokenRequired: config.answerToken !== '',
    transcribe: probeTranscribe(config),
    spawnAvailable: probeSpawn(config),
    spawnMaxPermission: config.spawnMaxPermission
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
 * `GET /api/settings` — the settings that aren't per-device (see lib/settings.ts).
 *
 * `notifyAvailable` is filled here rather than in the store: it is the one field
 * derived from `Config`, and `lib/settings.ts` deliberately never reads config.
 * The topic itself is never returned — it is both the address and the credential.
 */
export function serveSettingsRead(config: Config, res: ServerResponse): void {
  sendJson(res, 200, {
    ...getSettings(),
    notifyAvailable: config.ntfyTopic !== '',
    // Read per request, not cached: the whole point is to notice a file that
    // changed after this process read it. One `readFileSync` of a small file.
    staleEnvKeys: staleEnvKeys()
  });
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
      walkAbsent: absent
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
    walkAbsent: null
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
      recording: false, walk: [], exhaustAt: null, walkAbsent: 'recording-off'
    } satisfies UsageProfileResponse);
  }
}

/**
 * How much of the history log a rate fit reads.
 *
 * Sized for the baseline horizon at the worst case — one write-on-change
 * sample per minute for 17 days is ~24_500 lines of ~80 bytes, under 2 MB — so
 * the fit can never be quietly starved of the oldest part of its own baseline.
 * Quiet stretches write the 15-minute heartbeat instead and cost far less.
 */
export const RATES_HISTORY_BYTES = 4_194_304;

/**
 * An honest empty body — no ledger yet, recording off, or a failed fit.
 *
 * `coverage` is present and zeroed rather than absent: the counters have no
 * nulls, so "nothing measured" is a row of measured zeros, and an optional
 * field here would push a null check into the card for a state that cannot
 * happen. `startProvable` is false because nothing was read to prove it.
 */
function emptyRates(nowMs: number, recording: boolean, error?: true): UsageRatesResponse {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    recording,
    models: [],
    externalSharePct: null,
    coverage: {
      movedPct: 0, pricedPct: 0, mixedPct: 0, externalPct: 0,
      preLedgerPct: 0, missingPct: 0, partialPct: 0,
      recorderBreakHours: 0, startProvable: false
    },
    ...(error ? { error: true } : {})
  };
}

/**
 * Shape one `GET /api/usage/rates` body. Pure — no clock, no disk — so the
 * arithmetic and every honesty rule are testable (test/api-usage-rates.test.ts).
 *
 * One row per model that owns at least one attributable interval, richest
 * evidence first: the model you actually use should not sit under a model you
 * tried once. Models seen only in mixed, external or gap intervals get no row
 * at all — there is nothing to say about them yet, and a row of nulls reads as
 * a broken fit rather than as an absence of evidence.
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

  // One joint fit for every model, over the same current window the rows
  // report — so a row's split and its pooled rate never describe different
  // spans. A model that owns no interval still gets no row, so its fitted
  // split is simply not surfaced; which model earns a row is unchanged.
  const cur = currentRange(nowMs);
  const splits = fitSplits(intervals, cur.sinceMs, cur.untilMs);

  const rows: ModelRateRow[] = [...models]
    .map((model) => {
      const split = splits.get(model);
      return {
        ...driftRow(intervals, model, nowMs),
        pctPerMWeighted: split?.pctPerMWeighted ?? null,
        pctPerRequest: split?.pctPerRequest ?? null,
        splitVerdict: split === undefined ? ('thin' as const) : ('fitted' as const)
      };
    })
    .sort((a, b) => b.utilSum - a.utilSum || a.model.localeCompare(b.model));

  // Over the whole fitted horizon, not just the trailing window: it describes
  // how much of everything behind these numbers had to be thrown away.
  const share = externalShare(intervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);

  // Deliberately the same horizon as `externalSharePct` above: two disclosure
  // figures on one card that quietly spanned different windows would be a
  // defect, not a nuance.
  const buckets = coverageBreakdown(intervals, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);
  const breakMs = ledgerBreakMs(ledger, nowMs - BASELINE_MS, Number.POSITIVE_INFINITY);

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
    }
  };
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
    return sendBadBody(res, { error: 'expected {idleSecs?: number, answerSecs?: number, notify?: NotifyPolicy}' });
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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; timeoutMs?: unknown; permissionMode?: unknown; stopHookActive?: unknown; headless?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });

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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; event?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendBadBody(res, { error: 'bad body' });

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

/* -------------------------------------------------- spawn endpoints */

/**
 * `POST /api/spawn` — start a new headless `claude -p` session in an existing
 * recent project.
 *
 * Gated on the remote-answer toggle exactly like `serveTranscribe` above, and
 * for the stronger version of its reason: spawn writes a whole new session on
 * this machine. The pill is the app's only *runtime* kill switch (`CLAUDE_BIN`
 * is restart-scoped), so a switch that silently excluded the widest write path
 * would be worse than none — the user infers coverage. It is not an auth
 * boundary: `REMOTE_ANSWER` defaults to true and whoever can flip the pill off
 * can flip it back on. `HealthResponse.spawnAvailable` stays a pure capability
 * probe regardless, the same split `transcribe` uses on that payload.
 *
 * Check order, and the one part of it that is *not* about leaking less: the
 * probe runs before `tokenOk`, unlike `serveTranscribe` above, which documents
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
 * membership check against the enumerated recent-project list (the same
 * reasoning `serveManagementProject` documents for its `dirName` query param),
 * the latter through an exact-id match against the enumerated transcripts.
 * Resume additionally requires the target to be a `dashboard`-surface
 * (`sdk-cli`) session with no live hold — see docs/subsystems/spawn.md.
 */
export async function serveSpawn(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!probeSpawn(config)) return sendJson(res, 404, { error: 'spawn unavailable' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
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
      const t = listTranscripts(projectsRoot()).find(x => x.id === rid);
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
      if (listLaunching().some(e => e.sessionId === rid)) {
        return sendJson(res, 409, { error: 'already resuming' });
      }
      const ref = { dirName: t.dirName, name: nodePath.basename(tr.cwd), path: tr.cwd, lastActiveMs: t.mtimeMs };
      sessionId = launch(config, ref, parsed.input, rid);
    } else {
      const projectName = typeof body.project === 'string' ? body.project : '';
      const ref = resolveProject(config, projectName);
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
 * drop it from the store immediately (see `stopLaunch`'s own doc comment for
 * why a stopped launch can't be told apart from a crashed one downstream).
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
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
  if (!stopLaunch(id)) return sendJson(res, 404, { error: 'no live launch' });
  sendJson(res, 200, { stopped: true });
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
      Promise.resolve(listRecentProjects(config, { archivedIds: archivedSessionIds() }))
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
