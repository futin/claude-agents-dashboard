/**
 * A page taller than the viewport must stay clickable all the way down (#194). Pinned to the viewport at xl, Management's `.wrap` let a long Projects list
 * overflow `.main`, whose `overflow-x:clip` then refused hit-testing below its box: the board background stopped at the fold and every Pin past it was dead.
 * `layout.spec.ts` checks horizontal overflow only, and the shared fixtures give Projects three rows, so neither saw it.
 */
import type { Page } from '@playwright/test';

import type { PinsResponse } from '../../shared/types.js';

import { DAY, ago } from './fixtures/epoch.js';
import { pins } from './fixtures/pins.js';
import { HOME } from './fixtures/sessions.js';
import { expect, test } from './harness.js';
import { stage, VIEWPORT_HEIGHT } from './stage.js';

/** Sixty offered projects: tall enough to run well past a 900px viewport in every layout, three-across Tiles at 1921 included. */
const longPins: PinsResponse = {
  ...pins,
  older: Array.from({ length: 60 }, (_, i) => ({
    dirName: `-Users-dev-code-filler-${i}`,
    name: `filler-${i}`,
    path: `${HOME}/code/filler-${i}`,
    lastActiveMs: ago((10 + i) * DAY)
  }))
};

/** Pin buttons whose centre is on screen but whose hit lands on something else — the dead ones. */
function deadPins(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.pj-view .qp-term')].flatMap((b) => {
    const r = b.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (r.width === 0 || y < 0 || y > innerHeight) return [];
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === b || b.contains(hit)) ? [] : [`${b.closest('li,.pj-srw')?.textContent?.slice(0, 40)} → ${hit?.tagName}.${hit?.className}`];
  }));
}

const CASES = [
  { width: 1280, contentWidth: 'fixed' as const },
  { width: 1536, contentWidth: 'fixed' as const },
  { width: 1921, contentWidth: 'full' as const }
];

for (const { width, contentWidth } of CASES) {
  for (const layout of ['tiles', 'columns', 'lists'] as const) {
    test(`management projects · ${layout} · ${width} · every pin clickable past the fold`, async ({ page }) => {
      await stage(page, {
        section: 'management', theme: 'daylight', width, contentWidth, managementTab: 'projects',
        storage: { 'management.projectsLayout': layout }, fixtures: { '/api/pins': longPins }
      });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

      const box = await page.evaluate(() => ({
        doc: document.documentElement.scrollHeight,
        wrap: document.querySelector('.wrap')!.getBoundingClientRect().bottom,
        view: document.querySelector('.pj-view')!.getBoundingClientRect().bottom
      }));
      expect(box.doc, 'the fixture must outgrow the viewport or this case proves nothing').toBeGreaterThan(VIEWPORT_HEIGHT * 1.5);
      expect(await deadPins(page)).toEqual([]);
      expect(box.wrap, '.wrap must hold the whole Projects view').toBeGreaterThanOrEqual(box.view);
    });
  }
}

// The mirror case: Analytics is the one section whose tab is its own scroller, so it must stay pinned to the viewport.
test('analytics · 1536 · stays pinned to the viewport', async ({ page }) => {
  await stage(page, { section: 'analytics', theme: 'daylight', width: 1536, contentWidth: 'fixed' });
  const wrap = await page.evaluate(() => {
    const el = document.querySelector('.wrap')!;
    return { display: getComputedStyle(el).display, bottom: el.getBoundingClientRect().bottom };
  });
  expect(wrap.display).toBe('flex');
  expect(wrap.bottom).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
});
