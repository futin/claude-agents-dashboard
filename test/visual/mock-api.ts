/**
 * Answers every request the built client makes, inside the browser, so the server never runs (docs/subsystems/visual-tests.md).
 *
 * - GET `/api/*` with a fixture → 200 JSON. Matched on pathname; the query string is ignored. An exact pattern beats a `:param` one.
 * - GET `/api/*` with no fixture → 404, recorded. A new endpoint can never bake a loading or error state into a baseline unnoticed.
 * - Any other method to `/api/*` → 405, recorded.
 * - Google Fonts → the vendored copy under `fonts/`. Same-origin assets → the preview server. Anything else → aborted, recorded.
 *
 * Knows endpoints, nothing about the UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page, Request } from '@playwright/test';

import { ORIGIN } from './origin.js';

/**
 * Pathname pattern → JSON response body. `/api/sessions` or `/api/sessions/:id/chat` (any `:name` segment matches one path segment). A body may be a function
 * of the request URL, for the one endpoint whose answer must depend on its query: the chat drawer's `?after=` tail poll, which appends whatever it gets.
 */
export type FixtureMap = Record<string, unknown>;

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');

const failures = new WeakMap<Page, string[]>();
const inFlight = new WeakMap<Page, Set<Request>>();

/** The refusals recorded on this page so far, in order. */
export function mockApiFailures(page: Page): string[] {
  return [...(failures.get(page) ?? [])];
}

/** How many `/api` requests the page has issued that have not finished yet. */
export function pendingApiRequests(page: Page): number {
  return inFlight.get(page)?.size ?? 0;
}

function record(page: Page, line: string): void {
  failures.get(page)!.push(line);
}

function matches(pattern: string, pathname: string): boolean {
  const a = pattern.split('/');
  const b = pathname.split('/');
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') ? b[i] !== '' : seg === b[i]);
}

/** The fixture for `pathname`: the exact key first, then the first `:param` pattern that fits. */
export function findFixture(fixtures: FixtureMap, pathname: string): { found: true; body: unknown } | { found: false } {
  if (Object.prototype.hasOwnProperty.call(fixtures, pathname)) return { found: true, body: fixtures[pathname] };
  for (const pattern of Object.keys(fixtures)) {
    if (pattern.includes('/:') && matches(pattern, pathname)) return { found: true, body: fixtures[pattern] };
  }
  return { found: false };
}

/** The vendored file a Google Fonts URL maps to, or null. The CSS is keyed by host; each woff2 by its basename. */
function fontFile(url: URL): { file: string; type: string } | null {
  if (url.hostname === 'fonts.googleapis.com' && url.pathname === '/css2') {
    return { file: path.join(FONTS_DIR, 'hanken-grotesk.css'), type: 'text/css; charset=utf-8' };
  }
  if (url.hostname === 'fonts.gstatic.com') {
    return { file: path.join(FONTS_DIR, path.basename(url.pathname)), type: 'font/woff2' };
  }
  return null;
}

export async function installMockApi(page: Page, fixtures: FixtureMap): Promise<void> {
  failures.set(page, []);
  const pending = new Set<Request>();
  inFlight.set(page, pending);

  const isApi = (req: Request): boolean => {
    const url = new URL(req.url());
    return url.origin === ORIGIN && url.pathname.startsWith('/api/');
  };
  page.on('request', (req) => { if (isApi(req)) pending.add(req); });
  page.on('requestfinished', (req) => { pending.delete(req); });
  page.on('requestfailed', (req) => { pending.delete(req); });

  await page.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());

    if (url.origin === ORIGIN) {
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const where = url.pathname + url.search;
      if (method !== 'GET') {
        record(page, `${method} ${where}: writes are refused`);
        return route.fulfill({ status: 405, contentType: 'application/json', body: '{"error":"refused by mock-api"}' });
      }
      const hit = findFixture(fixtures, url.pathname);
      if (!hit.found) {
        record(page, `${method} ${where}: no fixture`);
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no fixture"}' });
      }
      const body = typeof hit.body === 'function' ? (hit.body as (url: URL) => unknown)(url) : hit.body;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    }

    const font = fontFile(url);
    if (font && fs.existsSync(font.file)) {
      return route.fulfill({
        status: 200,
        contentType: font.type,
        headers: { 'access-control-allow-origin': '*' },
        body: fs.readFileSync(font.file)
      });
    }

    record(page, `${method} ${req.url()}: off-origin request refused`);
    return route.abort('blockedbyclient');
  });
}
