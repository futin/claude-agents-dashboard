/**
 * Shared plumbing for the `api-*.test.ts` files: a real HTTP server running the
 * real route table from `server/index.ts`, against a throwaway `.env` and a
 * throwaway `$HOME`.
 *
 * Why a socket and the router rather than calling the handler directly: the
 * whole point of these tests is the layer *above* `lib/*` — auth gating, body
 * parsing, id validation, status-code mapping, and `res.on('close')`. Two of
 * those (a body that never parses, a client that hangs up mid-wait) have no
 * meaning without a real request stream, and the route table's ordering traps
 * (chat before detail, `:id/answer` before `:id`) have no meaning without the
 * router. `test/spawn-endpoint.test.ts` predates this and drives its two
 * handlers directly; everything added since goes through here.
 *
 * Isolation, and why each piece is needed:
 *   - **cwd** → a tmpdir, because `remoteState` resolves the toggle from
 *     `.remote-answer.json` relative to cwd and the repo's own file must not
 *     decide a test.
 *   - **$HOME** → the same tmpdir, because `projectsRoot()`, `claudeHome()` and
 *     therefore the session/management/analytics readers all hang off it. A
 *     developer's real `~/.claude` would otherwise make these tests pass or
 *     fail depending on whose machine ran them.
 *   - **the four RAM stores** are reset either side, since they outlive any one
 *     server and `pending`/`plans`/`messages` hold live timers.
 *
 * Nothing here spawns a process or reaches the network: `SKIP_PROC_SCAN=true`
 * keeps the scan off `ps`, `SHOW_USAGE=false` keeps it off the usage cache, and
 * an unset `NTFY_TOPIC` makes `maybeSend` a no-op.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createRequestListener } from '../server/index.js';
import { loadConfig } from '../server/lib/config.js';
import { resetStore as resetMessages } from '../server/lib/messages.js';
import { resetStore as resetPending } from '../server/lib/pending.js';
import { resetStore as resetPlans } from '../server/lib/plans.js';
import { resetState } from '../server/lib/remoteState.js';
import type { Config } from '../server/lib/config.js';

/** One `it`-style case. Async throughout: every request below is a promise. */
export async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A completed reply. `json` is null when the body was not JSON. */
export interface Reply {
  status: number;
  json: Record<string, unknown> | null;
  raw: string;
  /** Lower-cased response headers. Needed to assert a redirect's `location`. */
  headers: Record<string, string | string[] | undefined>;
}

/** A request whose response is deliberately not awaited — see `harness.open`. */
export interface OpenRequest {
  /** Kill the socket from the client side, as an interrupted hook does. */
  abort(): void;
  /** Resolves if the server ever does answer (it should not, for a held wait). */
  reply: Promise<Reply>;
}

export interface RequestOptions {
  method?: string;
  /** Sent verbatim — pass a malformed string to exercise the 400 path. */
  body?: string;
  headers?: Record<string, string>;
}

export interface Harness {
  /** `http://127.0.0.1:<port>`. */
  base: string;
  /** The config the router was built with — same object the handlers see. */
  cfg: Config;
  /** The throwaway `$HOME`, which is also cwd. */
  home: string;
  /**
   * Write a transcript so `listTranscripts`/`sessionExists` can see `id`.
   * `records` defaults to a single user message; pass more to give the chat
   * endpoint something to page through.
   */
  plant(id: string, records?: unknown[]): string;
  /** One request, awaited to completion. */
  req(pathname: string, options?: RequestOptions): Promise<Reply>;
  /** One request whose response is left hanging — for the wait endpoints. */
  open(pathname: string, options?: RequestOptions): OpenRequest;
}

/** The project directory every planted transcript goes in. */
const PROJECT_DIR = '-fake-proj';

/** A minimal user record — enough for `listTranscripts` and the chat reader. */
export function userRecord(uuid: string, text: string, cwd: string): unknown {
  return {
    uuid, type: 'user', entrypoint: 'cli', cwd,
    timestamp: '2026-07-01T10:00:00Z',
    message: { role: 'user', content: text }
  };
}

function resetStores(): void {
  resetState();
  resetPending();
  resetPlans();
  resetMessages();
}

/**
 * Run `fn` against a live server built from `envBody`.
 *
 * The server is closed with `closeAllConnections()` first: a held wait keeps a
 * socket open by design, so a plain `close()` would block until its deadline
 * and hang the whole suite.
 */
export async function withServer(envBody: string, fn: (h: Harness) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-api-'));
  const envPath = path.join(home, '.env');
  fs.writeFileSync(envPath, envBody);
  fs.mkdirSync(path.join(home, '.claude', 'projects', PROJECT_DIR), { recursive: true });

  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  process.chdir(home);
  process.env.HOME = home;
  resetStores();

  const cfg = loadConfig({ envPath });
  const server = http.createServer(createRequestListener(cfg));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const harness: Harness = {
    base, cfg, home,
    plant(id, records) {
      const file = path.join(home, '.claude', 'projects', PROJECT_DIR, `${id}.jsonl`);
      const recs = records ?? [userRecord(`${id}-u1`, 'hello', home)];
      fs.writeFileSync(file, recs.map(r => JSON.stringify(r)).join('\n') + '\n');
      return file;
    },
    req: (pathname, options) => request(base, pathname, options),
    open: (pathname, options) => openRequest(base, pathname, options)
  };

  try {
    await fn(harness);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    resetStores();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * One request, resolved when the response has fully arrived.
 *
 * The `settle`-once guard is the same one `api-body.test.ts` documents: a
 * refused body is answered while the client may still be uploading, so the
 * request stream can legitimately error *after* the response was read in full,
 * and an unhandled `'error'` on a bare `http.request` kills the test process.
 */
export function request(base: string, pathname: string, options: RequestOptions = {}): Promise<Reply> {
  const { method = 'GET', body, headers = {} } = options;
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void): void => { if (done) return; done = true; fn(); };
    const req = http.request(
      `${base}${pathname}`,
      { method, headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers } },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          const json = (() => {
            try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
          })();
          settle(() => resolve({ status: res.statusCode || 0, json, raw, headers: res.headers }));
        });
        res.on('error', e => settle(() => reject(e)));
      }
    );
    req.on('error', e => settle(() => reject(e)));
    req.end(body);
  });
}

/**
 * Fire a request and hand back a handle instead of awaiting it — the only way
 * to test an endpoint that holds its response open. `reply` rejects on abort,
 * which is the expected outcome for a hold the test then kills, so callers that
 * abort must attach a catch (see the wait tests).
 */
export function openRequest(base: string, pathname: string, options: RequestOptions = {}): OpenRequest {
  const { method = 'POST', body, headers = {} } = options;
  let settled = false;
  let abortFn = (): void => { /* replaced below once the request object exists */ };
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      `${base}${pathname}`,
      { method, headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers } },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const json = (() => {
            try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
          })();
          resolve({ status: res.statusCode || 0, json, raw, headers: res.headers });
        });
      }
    );
    req.on('error', e => { if (!settled) { settled = true; reject(e); } });
    req.end(body);
    abortFn = (): void => { req.destroy(); };
  });
  // Nothing may reject unhandled: an aborted hold is the normal path here.
  reply.catch(() => undefined);
  return { abort: () => abortFn(), reply };
}

/**
 * Wait for `predicate` to hold, polling on the macrotask queue.
 *
 * The `res.on('close')` cleanup a wait test asserts is triggered by a socket
 * event on the *server* side, which has no client-visible completion — so the
 * only honest way to observe it is to poll the store and fail on a timeout,
 * rather than sleep a guessed number of milliseconds.
 */
export async function until(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}
