#!/usr/bin/env node
/**
 * index.ts — HTTP entry for the Claude Agents Dashboard.
 *
 * Routes:
 *   GET /api/sessions  → JSON session snapshot (see api.ts)
 *   everything else    → static files from client/dist (production build)
 *
 * In development you visit the Vite dev server (default :5173), which proxies
 * /api here; this server only needs to answer the API. In production, run
 * `pnpm build` then `pnpm start` — this server serves the built client too.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { loadConfig } from './lib/config.js';
import { serveSessions } from './api.js';
import { openSession } from './openSession.js';

const config = loadConfig();
const isProd = process.env.NODE_ENV === 'production';
const clientDist = path.join(process.cwd(), 'client', 'dist');

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

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/open-session') && req.method === 'POST') {
    return openSession(config, req, res);
  }
  if (req.url && req.url.startsWith('/api/sessions')) {
    return serveSessions(config, res);
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
        if (p === 'darwin') spawn('open', [url], { stdio: 'ignore' });
        else if (p === 'win32') spawn('cmd', ['/c', 'start', url], { stdio: 'ignore' });
        else spawn('xdg-open', [url], { stdio: 'ignore' });
      } catch { /* best-effort */ }
    }
  });
}

export { server, config };
