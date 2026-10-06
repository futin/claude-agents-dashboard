/**
 * Proves `mock-api`'s refusals. The view specs never trigger them, so this is the only evidence they work.
 *
 * Deliberately not from a staged page (spec §9.3 says "staged"): the app's own requests would mix into the failure list being asserted. Each case serves an
 * empty `/__blank` document instead — registered after `installMockApi`, so Playwright tries it first — and fetches from there. Imports Playwright's own
 * `test`, not the harness's: recording failures is the point here, so the fail-on-refusal teardown must not run.
 */
import { test, expect, type Page } from '@playwright/test';

import { installMockApi, mockApiFailures, type FixtureMap } from './mock-api.js';

async function blankPage(page: Page, fixtures: FixtureMap): Promise<void> {
  await installMockApi(page, fixtures);
  await page.route('**/__blank', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
  await page.goto('/__blank');
}

test('a GET with no fixture answers 404 and is recorded', async ({ page }) => {
  await blankPage(page, {});
  const status = await page.evaluate(async () => (await fetch('/api/nope')).status);
  expect(status).toBe(404);
  expect(mockApiFailures(page)).toEqual(['GET /api/nope: no fixture']);
});

test('a write answers 405 and is recorded', async ({ page }) => {
  await blankPage(page, { '/api/pins': { pins: [] } });
  const status = await page.evaluate(async () => (await fetch('/api/pins', { method: 'POST', body: '{}' })).status);
  expect(status).toBe(405);
  expect(mockApiFailures(page)).toContain('POST /api/pins: writes are refused');
});

test('the query string is ignored when matching', async ({ page }) => {
  const body = { marker: 'sessions-fixture', n: 3 };
  await blankPage(page, { '/api/sessions': body });
  const got = await page.evaluate(async () => {
    const res = await fetch('/api/sessions?maxSessions=5');
    return { status: res.status, body: await res.json() };
  });
  expect(got).toEqual({ status: 200, body });
  expect(mockApiFailures(page)).toEqual([]);
});

test('an exact pathname beats a :param pattern', async ({ page }) => {
  await blankPage(page, {
    '/api/sessions/:id/chat': { which: 'param' },
    '/api/sessions/abc/chat': { which: 'exact' }
  });
  const got = await page.evaluate(async () => (await fetch('/api/sessions/abc/chat')).json());
  expect(got).toEqual({ which: 'exact' });
});

test('an off-origin request is aborted and recorded', async ({ page }) => {
  await blankPage(page, {});
  const outcome = await page.evaluate(async () => {
    try { await fetch('https://example.com/x'); return 'resolved'; } catch { return 'rejected'; }
  });
  expect(outcome).toBe('rejected');
  expect(mockApiFailures(page)).toContain('GET https://example.com/x: off-origin request refused');
});
