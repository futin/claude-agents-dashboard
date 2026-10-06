/** Proves `stage` reaches the state every shot depends on, and that the harness fails a case on a mock-api refusal. */
import { SECTIONS } from '../../client/src/lib/sections.js';

import { EPOCH } from './fixtures/epoch.js';
import { FIXTURE_FIRST_MESSAGE, FIXTURE_SESSION_ID } from './fixtures/index.js';
import { sessions } from './fixtures/sessions.js';
import { expect, test } from './harness.js';
import { mockApiFailures } from './mock-api.js';
import { isReady, stage, type StageOpts } from './stage.js';

const BASE: StageOpts = { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed' };

test('the seeded theme is applied', async ({ page }) => {
  await stage(page, BASE);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('daylight');
});

test('a seeded midnight is applied', async ({ page }) => {
  await stage(page, { ...BASE, theme: 'midnight' });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('midnight');
});

// midnight is DEFAULT_SETTINGS.theme, so only a non-default theme proves the seed decides rather than the default.
test('the seeded theme beats the default', async ({ page }) => {
  await stage(page, { ...BASE, theme: 'amber' });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('amber');
});

test('--font-scale on .shell resolves to 1', async ({ page }) => {
  await stage(page, BASE);
  const scale = await page.evaluate(() => getComputedStyle(document.querySelector('.shell')!).getPropertyValue('--font-scale').trim());
  expect(Number(scale)).toBe(1);
});

test('the clock is frozen at EPOCH', async ({ page }) => {
  await stage(page, BASE);
  const now = await page.evaluate(() => ({ now: Date.now(), iso: new Date().toISOString() }));
  expect(now).toEqual({ now: EPOCH, iso: '2026-09-30T14:00:00.000Z' });
});

test('time zone is UTC and devicePixelRatio is 1 regardless of the host', async ({ page }) => {
  await stage(page, BASE);
  const env = await page.evaluate(() => ({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, dpr: window.devicePixelRatio }));
  expect(env).toEqual({ tz: 'UTC', dpr: 1 });
});

test('Hanken Grotesk is loaded, not a fallback', async ({ page }) => {
  await stage(page, BASE);
  const loaded = await page.evaluate(() =>
    [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Hanken Grotesk' && f.status === 'loaded')
  );
  expect(loaded).toBe(true);
});

test('every fixture session renders as a board card', async ({ page }) => {
  await stage(page, BASE);
  expect(sessions.sessions.length).toBe(4);
  await expect(page.locator('.bcard')).toHaveCount(4);
  expect(mockApiFailures(page)).toEqual([]);
});

test.fail('harness proof: a refused request fails the case', async ({ page }) => {
  await stage(page, BASE);
  await page.evaluate(async () => { await fetch('/api/nope'); });
});

test('the ?session= deep link opens the chat drawer on the fixture chat', async ({ page }) => {
  await stage(page, { ...BASE, query: '?session=' + FIXTURE_SESSION_ID });
  const drawer = page.locator('aside.chat');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(FIXTURE_FIRST_MESSAGE);
});

for (const { id, label } of SECTIONS) {
  test(`stages the ${id} section`, async ({ page }) => {
    await stage(page, { ...BASE, section: id });
    // Polled, not read once: the view's own poll may have a request in flight at any given instant.
    await expect.poll(() => isReady(page)).toBe(true);
    expect(mockApiFailures(page)).toEqual([]);
    await expect(page.locator('.rail-link[aria-current="page"]')).toHaveText(label);
  });
}
