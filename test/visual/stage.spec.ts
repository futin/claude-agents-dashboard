/** Proves `stage` reaches the state every shot depends on, and that the harness fails a case on a mock-api refusal. */
import { SECTIONS } from '../../client/src/lib/sections.js';

import { DESKTOP_HANDOVER_NOTE } from '../../client/src/lib/launchSurface.js';

import { EPOCH } from './fixtures/epoch.js';
import { FIXTURE_FIRST_MESSAGE, FIXTURE_SESSION_ID } from './fixtures/index.js';
import { SESSION_IDS, sessions } from './fixtures/sessions.js';
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

// daylight is DEFAULT_SETTINGS.theme, so only a non-default theme proves the seed decides rather than the default.
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

// The mock API serves no `/stop`, so a request would fail the case: the arm and cancel taps are proven request-free, and `Really stop?` is never clicked.
for (const width of [1280, 375]) {
  test(`the drawer's sidecar carries the two-stage stop control at ${width}`, async ({ page }) => {
    await stage(page, { ...BASE, width, query: '?session=' + FIXTURE_SESSION_ID });
    const side = page.locator('aside.chat .chat-side');
    await expect(side.locator('.stop-go')).toHaveText('Stop session');
    await expect(page.locator('aside.chat .chat-head .stop-go')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await side.locator('.stop-go').click();
    await expect(side.locator('.stop-go')).toHaveText('Really stop?');
    await expect(side.locator('.stop-cancel')).toHaveText('Cancel');

    await side.locator('.stop-cancel').click();
    await expect(side.locator('.stop-go')).toHaveText('Stop session');
    await expect(side.locator('.stop-cancel')).toHaveCount(0);
    expect(mockApiFailures(page)).toEqual([]);
  });
}

test('the drawer has no stop control for a session this dashboard did not spawn', async ({ page }) => {
  await stage(page, { ...BASE, query: '?session=' + SESSION_IDS.idle });
  const drawer = page.locator('aside.chat');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.stop-ctl')).toHaveCount(0);
});

// The idle fixture session, made a headless one with a name long enough to crowd the head: the case the hand-over button's wrap once overflowed in (the nowrap
// button spilled left over the pill and the title at 375). The title and the pill must give way instead, and the head's items must not overlap.
const handedOverSessions = {
  ...sessions,
  sessions: sessions.sessions.map(s => s.id === SESSION_IDS.idle
    ? { ...s, surface: 'dashboard' as const, sessionName: 'Orders rate limiting with sliding window buckets and a long tail' }
    : s)
};

for (const width of [1280, 375]) {
  test(`the drawer head holds the hand-over button without overflow or overlap at ${width}`, async ({ page }) => {
    await stage(page, { ...BASE, width, query: '?session=' + SESSION_IDS.idle, fixtures: { '/api/sessions': handedOverSessions } });
    const head = page.locator('aside.chat .chat-head');
    const button = head.locator('.chat-desktop');
    await expect(button).toHaveText('Open in desktop app');
    await expect(button).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    const boxes = await page.evaluate(() => {
      const rect = (sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return { left: r.left, right: r.right };
      };
      return {
        head: rect('aside.chat .chat-head'),
        items: ['.chat-title', '.proj-pill', '.chat-desktop-wrap', '.chat-x'].map(sel => rect('aside.chat .chat-head ' + sel)),
        button: rect('aside.chat .chat-desktop'),
        wrap: rect('aside.chat .chat-desktop-wrap')
      };
    });
    // The wrap is exactly the button's width: the button sits inside it, and no note sets the wrap's size.
    expect(boxes.button.left).toBeGreaterThanOrEqual(boxes.wrap.left - 0.5);
    expect(boxes.button.right).toBeLessThanOrEqual(boxes.wrap.right + 0.5);
    for (let i = 0; i < boxes.items.length - 1; i++) {
      expect(boxes.items[i].right, `head item ${i} runs into item ${i + 1}`).toBeLessThanOrEqual(boxes.items[i + 1].left + 0.5);
    }
    expect(boxes.items[boxes.items.length - 1].right).toBeLessThanOrEqual(boxes.head.right + 0.5);
    expect(mockApiFailures(page)).toEqual([]);
  });
}

// A session mid-turn gets the button disabled with its note: the note must wrap to the button's width, not push the head wider.
test('the hand-over note on a working session stays inside the head at 375', async ({ page }) => {
  await stage(page, { ...BASE, width: 375, query: '?session=' + FIXTURE_SESSION_ID });
  const head = page.locator('aside.chat .chat-head');
  await expect(head.locator('.chat-desktop')).toBeDisabled();
  await expect(head.locator('.chat-desktop-note')).toHaveText('Stop it first');
  const widths = await page.evaluate(() => ({
    wrap: document.querySelector('aside.chat .chat-desktop-wrap')!.getBoundingClientRect().width,
    button: document.querySelector('aside.chat .chat-desktop')!.getBoundingClientRect().width
  }));
  expect(widths.wrap).toBeCloseTo(widths.button, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

// The launch form's target picker. 1280 opens it from the board's `+ New session`, 375 from the strip's `+`.
for (const { width, open } of [{ width: 1280, open: '.newbtn' }, { width: 375, open: '.s-plus' }]) {
  test(`the launch form offers Dashboard | Desktop and fixes the two toggles under Desktop at ${width}`, async ({ page }) => {
    await stage(page, { ...BASE, width });
    await page.locator(open).click();
    const form = page.locator('.spawn');
    await expect(form).toBeVisible();
    const name = form.locator('.sp-field .qp-other');
    await expect(form.locator('.sp-surface button')).toHaveText(['Dashboard', 'Desktop']);
    await expect(form.locator('.sp-surface button.on')).toHaveText('Dashboard');
    await expect(name).toBeEnabled();
    await expect(form.getByText('SPAWN_MAX_PERMISSION')).toHaveCount(1);

    await form.locator('.sp-surface button', { hasText: 'Desktop' }).click();
    await expect(form.locator('.sp-surface button.on')).toHaveText('Desktop');
    // The first turn runs headless, so name, model, effort and permission still apply; only the two toggles are fixed.
    await expect(name).toBeEnabled();
    const remote = form.locator('.set-seg[aria-label="Remote control"] button');
    const close = form.locator('.set-seg[aria-label="Close when done"] button');
    await expect(remote.first()).toBeDisabled();
    await expect(form.locator('.set-seg[aria-label="Remote control"] button.on')).toHaveText('Off');
    await expect(form.locator('.set-seg[aria-label="Close when done"] button.on')).toHaveText('On');
    await expect(close.first()).toBeDisabled();
    await expect(form.locator('.sp-note', { hasText: DESKTOP_HANDOVER_NOTE })).toBeVisible();
    await expect(form.getByText('SPAWN_MAX_PERMISSION')).toHaveCount(1);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(mockApiFailures(page)).toEqual([]);
  });
}

for (const { id, label } of SECTIONS) {
  test(`stages the ${id} section`, async ({ page }) => {
    await stage(page, { ...BASE, section: id });
    // Polled, not read once: the view's own poll may have a request in flight at any given instant.
    await expect.poll(() => isReady(page)).toBe(true);
    expect(mockApiFailures(page)).toEqual([]);
    await expect(page.locator('.rail-link[aria-current="page"]')).toHaveText(label);
  });
}
