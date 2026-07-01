/**
 * openSession.ts — POST /api/open-session handler.
 *
 * Relaunches a specific Claude Code session in a new iTerm window:
 * `cd <projectPath> && claude --resume <sessionId>`.
 *
 * A browser cannot spawn a terminal, so this runs on the local Node server.
 * The client sends ONLY the session id; the cwd is re-derived server-side from
 * our own scan (never trust a client-supplied path) and the id is validated as
 * a UUID, so nothing user-controlled reaches the shell unescaped. macOS only.
 */

import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Config } from './lib/config.js';
import { scanSessions } from './lib/scan.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096;

/** Single-quote a path for safe embedding in the emitted `cd ...` shell command. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function reply(res: ServerResponse, code: number, body: object): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function openSession(config: Config, req: IncomingMessage, res: ServerResponse): void {
  if (process.platform !== 'darwin') {
    reply(res, 400, { ok: false, error: 'macOS only' });
    return;
  }

  let raw = '';
  let aborted = false;
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      aborted = true;
      reply(res, 413, { ok: false, error: 'body too large' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;

    let id = '';
    try {
      id = JSON.parse(raw).id;
    } catch {
      /* falls through to validation below */
    }
    if (!UUID.test(id || '')) {
      reply(res, 400, { ok: false, error: 'bad id' });
      return;
    }

    // Resolve cwd from the server's own scan — do NOT trust a client cwd.
    let projectPath: string | null = null;
    try {
      projectPath = scanSessions(config).sessions.find((s) => s.id === id)?.projectPath ?? null;
    } catch {
      reply(res, 500, { ok: false, error: 'scan failed' });
      return;
    }
    if (!projectPath) {
      reply(res, 404, { ok: false, error: 'session/cwd not found' });
      return;
    }

    // argv array → no shell layer; JSON.stringify → valid AppleScript string literal.
    const cmd = `cd ${shq(projectPath)} && claude --resume ${id}`;
    execFile(
      'osascript',
      [
        '-e', 'tell application "iTerm"',
        '-e', 'activate',
        '-e', 'create window with default profile',
        '-e', `tell current session of current window to write text ${JSON.stringify(cmd)}`,
        '-e', 'end tell'
      ],
      (err) => {
        if (err) reply(res, 500, { ok: false, error: 'launch failed' });
        else reply(res, 200, { ok: true });
      }
    );
  });
}
