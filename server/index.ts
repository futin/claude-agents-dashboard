#!/usr/bin/env node
/**
 * index.ts — HTTP entry for the Claude Agents Dashboard.
 *
 * Routes:
 *   GET  /api/sessions          → JSON session snapshot (see api.ts)
 *   GET  /api/sessions/:id      → one session's subagent activity
 *   GET  /api/sessions/:id/chat → a page of that session's chat history
 *   GET/POST /api/settings      → the non-per-device settings (see lib/settings.ts)
 *   everything else             → static files from client/dist (production build)
 *
 * In development you visit the Vite dev server (default :5174), which proxies
 * /api here; this server only needs to answer the API. In production, run
 * `pnpm build` then `pnpm start` — this server serves the built client too.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { loadConfig } from './lib/config.js';
import {
  serveSessions, serveSessionDetail, serveSessionChat,
  serveManagementIndex, serveManagementProject, serveManagementFile,
  serveAnalytics, serveHealth, serveQuestionWait, serveSessionQuestion, serveSessionAnswer,
  serveRemoteAnswerToggle, servePermissionNotify,
  servePlanWait, serveSessionPlan, serveSessionPlanAnswer,
  serveMessageWait, serveSessionMessage, serveSessionMessageAnswer,
  serveSettingsRead, serveSettingsWrite, serveNotifyEvent, serveNotifyTest,
  serveTranscribe, serveSpawn, serveSpawnStop, serveUsageProfile
} from './api.js';
import { startUsageRecording } from './lib/usage-history.js';
import { refreshUsageNow } from './lib/usage.js';

const config = loadConfig();
const isProd = process.env.NODE_ENV === 'production';
const clientDist = path.join(process.cwd(), 'client', 'dist');

/**
 * A rejected promise nobody awaited must not end a dashboard that a dozen
 * sessions are being watched through.
 *
 * Almost every handler below is dispatched with `void serveX(...)` — the
 * request listener is sync, the handlers are async, and nothing awaits them. On
 * Node's default `unhandledRejection: throw`, one throw inside any of them (a
 * `res.writeHead` on an already-ended response, an `fs` call losing a race with
 * a rotated transcript) takes the whole process down. Each handler owns a
 * try/catch where it has a meaningful fallback; this is the floor under all of
 * them, and it deliberately only **logs**: an unhandled rejection is a bug to
 * fix, not a reason to stop serving the other 20 routes. Same log prefix as
 * `api.ts`'s own catch blocks, so it lands in one grep.
 *
 * Not an `uncaughtException` handler, and `decodePath` below is not made
 * redundant by this: a `URIError` from `decodeURIComponent` is thrown
 * *synchronously* inside the request listener, so it never becomes a rejection.
 * Swallowing genuine synchronous throws process-wide would keep a
 * possibly-broken process alive, which is a different and worse trade.
 */
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[dashboard] unhandled rejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/** Serve a file from client/dist, falling back to index.html (SPA-style). */
function serveStatic(urlPath: string, res: http.ServerResponse): void {
  const clean = urlPath.split('?')[0].replace(/^\/+/, '');
  let filePath = path.join(clientDist, clean || 'index.html');
  // Prevent path traversal outside the dist root.
  if (!filePath.startsWith(clientDist)) filePath = path.join(clientDist, 'index.html');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(clientDist, 'index.html');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. Run `pnpm build` first, or use `pnpm dev`.');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/** The write endpoints are POST-only; everything else here is method-agnostic. */
function methodNotAllowed(res: http.ServerResponse): void {
  res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

/**
 * `decodeURIComponent` throws a `URIError` on malformed percent-encoding
 * (e.g. a lone `%ZZ`) — synchronously, inside this request listener, with no
 * `uncaughtException` handler anywhere in this process. Left unguarded, one
 * unauthenticated request (`POST /api/spawn/%ZZ/stop`, or the same against
 * any other id-scoped route below) throws before any handler — before even
 * `tokenOk` — and takes the whole dashboard process down for every session
 * it was watching. Every site that pulls an id out of the URL below goes
 * through this instead of calling `decodeURIComponent` directly.
 */
export function decodePath(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A URL segment that failed to decode (see `decodePath`). */
function badRequest(res: http.ServerResponse): void {
  res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'bad path encoding' }));
}

const server = http.createServer((req, res) => {
  // Management routes take query params — parse once. Handlers are async but
  // self-contained (they always end the response), so `void` keeps the
  // callback signature.
  const u = new URL(req.url || '/', 'http://local');
  if (u.pathname === '/api/management/file') {
    return void serveManagementFile(config, u.searchParams.get('path') || '', res);
  }
  if (u.pathname === '/api/management/project') {
    return void serveManagementProject(config, u.searchParams.get('dir') || '', res);
  }
  if (u.pathname === '/api/management') {
    return void serveManagementIndex(config, res);
  }
  if (u.pathname === '/api/analytics') {
    return void serveAnalytics(config, res);
  }
  if (u.pathname === '/api/health') {
    return void serveHealth(config, res, req);
  }
  // Read on GET, write on POST — the write is guarded like the others below.
  // Only holds settings a separate process must agree on (see lib/settings.ts);
  // the rest of the Settings page is per-device localStorage.
  if (u.pathname === '/api/settings') {
    if (req.method === 'POST') return void serveSettingsWrite(config, req, res);
    return void serveSettingsRead(config, res);
  }
  // The duty-cycle profile behind the weekly forecast — read-only, and never
  // carrying raw samples (see docs/subsystems/usage-limits.md).
  if (u.pathname === '/api/usage/profile') {
    return void serveUsageProfile(res);
  }
  // The only write endpoints in the app (see docs/subsystems/remote-answer.md).
  // `wait` holds its response open for minutes — that is by design.
  if (u.pathname === '/api/questions/wait') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveQuestionWait(config, req, res);
  }
  if (u.pathname === '/api/plans/wait') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void servePlanWait(config, req, res);
  }
  if (u.pathname === '/api/messages/wait') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveMessageWait(config, req, res);
  }
  if (u.pathname === '/api/remote-answer') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveRemoteAnswerToggle(config, req, res);
  }
  // Fire-and-forget flag from the PermissionRequest hook: a session is showing a
  // permission dialog (see docs/subsystems/permission-notify.md). Display-only.
  if (u.pathname === '/api/permissions/notify') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void servePermissionNotify(config, req, res);
  }
  // Push trigger for the Stop hook — the other three events notify from the
  // endpoint they were already POSTing to (see docs/subsystems/push-notify.md).
  if (u.pathname === '/api/notify/event') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveNotifyEvent(config, req, res);
  }
  if (u.pathname === '/api/notify/test') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveNotifyTest(config, req, res);
  }
  // Dictation: a recorded clip in, text out (see docs/subsystems/dictation.md).
  if (u.pathname === '/api/transcribe') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveTranscribe(config, req, res);
  }
  // Spawn a new headless session (see server/lib/spawn.ts). The id-scoped stop
  // route is anchored (`$`) and checked before the exact-path `/api/spawn`
  // check below it — the same route-order trap the chat/question/plan/message
  // regexes further down all document, kept here even though `===` equality
  // can't itself be prefix-swallowed, so the ordering stays defensive if that
  // check ever changes shape.
  const spawnStop = u.pathname.match(/^\/api\/spawn\/([^/]+)\/stop$/);
  if (spawnStop) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const id = decodePath(spawnStop[1]);
    if (id === null) return badRequest(res);
    return void serveSpawnStop(config, id, req, res);
  }
  if (u.pathname === '/api/spawn') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveSpawn(config, req, res);
  }
  // Like the chat route below, these must be matched before the detail regex,
  // whose `[^/?]+` would otherwise swallow `/api/sessions/:id/<anything>`.
  const question = u.pathname.match(/^\/api\/sessions\/([^/]+)\/question$/);
  if (question) {
    const id = decodePath(question[1]);
    if (id === null) return badRequest(res);
    return void serveSessionQuestion(id, res);
  }
  const answer = u.pathname.match(/^\/api\/sessions\/([^/]+)\/answer$/);
  if (answer) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const id = decodePath(answer[1]);
    if (id === null) return badRequest(res);
    return void serveSessionAnswer(config, id, req, res);
  }
  const plan = u.pathname.match(/^\/api\/sessions\/([^/]+)\/plan$/);
  if (plan) {
    const id = decodePath(plan[1]);
    if (id === null) return badRequest(res);
    return void serveSessionPlan(id, res);
  }
  const planAnswer = u.pathname.match(/^\/api\/sessions\/([^/]+)\/plan-answer$/);
  if (planAnswer) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const id = decodePath(planAnswer[1]);
    if (id === null) return badRequest(res);
    return void serveSessionPlanAnswer(config, id, req, res);
  }
  const message = u.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
  if (message) {
    const id = decodePath(message[1]);
    if (id === null) return badRequest(res);
    return void serveSessionMessage(id, res);
  }
  const messageAnswer = u.pathname.match(/^\/api\/sessions\/([^/]+)\/message-answer$/);
  if (messageAnswer) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const id = decodePath(messageAnswer[1]);
    if (id === null) return badRequest(res);
    return void serveSessionMessageAnswer(config, id, req, res);
  }
  // Chat route must be matched before the detail regex below, whose `[^/?]+`
  // would otherwise swallow `/api/sessions/:id/chat` and answer with agents.
  const chat = req.url && req.url.match(/^\/api\/sessions\/([^/?]+)\/chat(?:[?#]|$)/);
  if (chat) {
    const id = decodePath(chat[1]);
    if (id === null) return badRequest(res);
    return serveSessionChat(id, u.searchParams, res);
  }
  // Detail route must be matched before the generic prefix below, which would
  // otherwise swallow `/api/sessions/:id`.
  const detail = req.url && req.url.match(/^\/api\/sessions\/([^/?]+)/);
  if (detail) {
    const id = decodePath(detail[1]);
    if (id === null) return badRequest(res);
    return serveSessionDetail(id, res);
  }
  if (req.url && req.url.startsWith('/api/sessions')) {
    // Query params carry the Settings page's per-device scan knobs (limit /
    // lookback / active). The detail regex above needs a slash, so a bare
    // `/api/sessions?limit=20` still lands here.
    return serveSessions(config, res, u.searchParams);
  }
  return serveStatic(req.url || '/', res);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(config.port, () => {
    const url = `http://localhost:${config.port}`;
    console.log(`\n  ⚡ Claude Sessions dashboard → ${url}`);
    console.log(`     top ${config.maxSessions} · active < ${config.activeWindowMin}m · lookback ${config.lookbackHours}h`);
    if (!isProd) console.log('     (dev: API only — open the Vite dev server instead)\n');
    else console.log('');

    // Only auto-open when this server is the page (production build present).
    if (isProd) {
      try {
        const p = process.platform;
        const child =
          p === 'darwin' ? spawn('open', [url], { stdio: 'ignore' })
          : p === 'win32' ? spawn('cmd', ['/c', 'start', url], { stdio: 'ignore' })
          : spawn('xdg-open', [url], { stdio: 'ignore' });
        child.on('error', () => { /* no browser to open (e.g. headless/container) — best-effort */ });
      } catch { /* best-effort */ }
    }

    // Usage-history recording (opt-in, and re-read on every tick). Rehydrates
    // the 5h pace ring from disk, then samples on our own interval — the
    // /api/sessions poll only fires while a browser is open, which would make
    // the recorded history describe when the dashboard was watched rather than
    // when work happened. See docs/subsystems/usage-limits.md.
    if (config.showUsage) startUsageRecording(refreshUsageNow);
  });
}

export { server, config };
