/**
 * Puts a page into a known, frozen state for one shot: the mock API, the clock, the device settings the client reads at boot, the viewport, and a readiness
 * predicate polled until it holds. Knows how to reach a state, nothing about endpoints.
 */
import type { Page } from '@playwright/test';

import type { Section } from '../../client/src/lib/sections.js';
import type { Settings, ThemeId } from '../../client/src/lib/settings.js';

import { EPOCH } from './fixtures/epoch.js';
import { fixtures } from './fixtures/index.js';
import { expect } from './harness.js';
import { installMockApi, pendingApiRequests } from './mock-api.js';

export interface StageOpts {
  section: Section;
  theme: ThemeId;
  width: number;
  contentWidth: 'fixed' | 'full';
  /** Appended to `/`, e.g. `?session=<uuid>` to open the chat drawer. */
  query?: string;
}

export const VIEWPORT_HEIGHT = 900;

/**
 * Every field of `dashboard.settings`, explicitly. Typed as the whole `Settings` so a field added to the client fails `pnpm typecheck` here rather than taking
 * its default silently, and a changed `DEFAULT_SETTINGS` surfaces as a deliberate re-baseline rather than a mystery diff.
 */
function seededSettings(opts: StageOpts): Settings {
  return {
    theme: opts.theme,
    density: 'comfortable',
    fontScale: 100,
    refreshMs: 3000,
    maxSessions: 5,
    lookbackHours: 48,
    activeWindowMin: 5,
    landing: opts.section,
    chatFullText: false,
    spawnDefaultModel: '',
    spawnDefaultEffort: '',
    syncModel: '',
    syncEffort: '',
    notifyBrowser: false,
    usageTab: 'forecast',
    settingsTab: 'local',
    managementTab: 'git',
    // Not the default 'last', which defers to `dashboard.layout` (SessionsView.tsx).
    defaultLayout: 'board',
    contentWidth: opts.contentWidth
  };
}

/**
 * True once the page is ready to photograph: fonts settled and Hanken Grotesk actually loaded (`document.fonts.check` is true even when no face matches, so
 * it is not used), every `/api` request issued so far answered, and no element whose own text starts with "loading".
 */
export async function isReady(page: Page): Promise<boolean> {
  if (pendingApiRequests(page) > 0) return false;
  return page.evaluate(async () => {
    await document.fonts.ready;
    const hanken = [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Hanken Grotesk' && f.status === 'loaded');
    if (!hanken) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (/^loading/i.test((n.textContent ?? '').trim())) return false;
    }
    return true;
  });
}

export async function stage(page: Page, opts: StageOpts): Promise<void> {
  await installMockApi(page, fixtures);
  await page.clock.setFixedTime(EPOCH);
  // Both keys are JSON-encoded: usePersistedState JSON-parses, so the section is stored as `"usage"` with the quotes.
  await page.addInitScript(
    ([settings, section]) => {
      localStorage.setItem('dashboard.settings', settings);
      localStorage.setItem('dashboard.section', section);
    },
    [JSON.stringify(seededSettings(opts)), JSON.stringify(opts.section)] as const
  );
  await page.setViewportSize({ width: opts.width, height: VIEWPORT_HEIGHT });
  await page.goto('/' + (opts.query ?? ''));
  await expect.poll(() => isReady(page), { timeout: 5000, message: `page never became ready: ${JSON.stringify(opts)}` }).toBe(true);
}
