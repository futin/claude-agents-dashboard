/**
 * The screenshot matrix (spec §4): every `SECTIONS` view at the six daylight breakpoint tiers (`fixed`), the two full-width tiers (`full`) and the four other
 * themes at 1280, plus one Sessions shot with the chat drawer open. Zero tolerance — the config's `maxDiffPixels: 0` and `threshold: 0`.
 */
import type { Page } from '@playwright/test';

import { SECTIONS, type Section } from '../../client/src/lib/sections.js';
import type { ThemeId } from '../../client/src/lib/settings.js';

import { FIXTURE_SESSION_ID } from './fixtures/index.js';
import { gitSessions } from './fixtures/git-sessions.js';
import { pinsWithGone } from './fixtures/pins.js';
import { expect, test } from './harness.js';
import { isReady, stage, type StageOpts } from './stage.js';
import { DAYLIGHT_TIERS } from './tiers.js';

interface ShotCase extends StageOpts {
  kind: 'shot' | 'detail' | 'triage' | 'git-matrix' | 'git-inspector' | 'git-branches' | 'projects-tiles' | 'projects-columns' | 'projects-lists' | 'releases';
}

const OTHER_THEMES: ThemeId[] = ['midnight', 'amber', 'graphite', 'nightshift'];

function casesFor(section: Section): ShotCase[] {
  return [
    ...DAYLIGHT_TIERS.map((t) => ({ section, theme: 'daylight' as ThemeId, ...t, kind: 'shot' as const })),
    ...OTHER_THEMES.map((theme) => ({ section, theme, width: 1280, contentWidth: 'fixed' as const, kind: 'shot' as const }))
  ];
}

const GIT = {
  section: 'management' as Section,
  theme: 'daylight' as ThemeId,
  contentWidth: 'fixed' as const,
  fixtures: { '/api/sessions': gitSessions }
};
const PROJ = {
  section: 'management' as Section,
  theme: 'daylight' as ThemeId,
  contentWidth: 'fixed' as const,
  managementTab: 'projects' as const,
  fixtures: { '/api/pins': pinsWithGone }
};

const CASES: ShotCase[] = [
  ...SECTIONS.flatMap((s) => casesFor(s.id)),
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' },
  // The phone drawer folds the fixture plan's card to one `Plan 7/13 · …` line; the 1280 detail above pins its ellipsised `Plan · …` head.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' },
  // Triage draws its Working and Idle rows without `Tags`, so the task pill there has its own render site to pin.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', layout: 'triage', kind: 'triage' },
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', layout: 'triage', kind: 'triage' },
  // Git's default layout (Inbox) is what the management shots above show; the other layouts are seeded through the persisted key. The sessions fixture adds
  // an idle session on lumen-cli so the join draws all three chips.
  { ...GIT, width: 1280, storage: { 'management.gitLayout': 'matrix' }, kind: 'git-matrix' },
  { ...GIT, width: 375, storage: { 'management.gitLayout': 'inspector' }, kind: 'git-inspector' },
  { ...GIT, width: 1280, storage: { 'management.gitLayout': 'inspector' }, kind: 'git-inspector' },
  { ...GIT, width: 375, storage: { 'management.gitLayout': 'branches' }, kind: 'git-branches' },
  { ...GIT, width: 1280, storage: { 'management.gitLayout': 'branches' }, kind: 'git-branches' },
  // Projects with a pinned folder that is gone, so every layout shows the `Folder gone` chip.
  { ...PROJ, width: 1280, storage: { 'management.projectsLayout': 'tiles' }, kind: 'projects-tiles' },
  { ...PROJ, width: 1280, storage: { 'management.projectsLayout': 'columns' }, kind: 'projects-columns' },
  { ...PROJ, width: 375, storage: { 'management.projectsLayout': 'lists' }, kind: 'projects-lists' },
  // What's new, opened from the version chip: full screen on the phone (reached through the menu, whose last row the chip is), the 400px panel from `md`.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', kind: 'releases' },
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', kind: 'releases' }
];

/**
 * 12 per view × 6 views + 2 drawer details + 2 triage + 5 git layouts + 3 projects layouts + 2 What's new drawers. A changed `SECTIONS` fails here until the
 * matrix (and its baselines) are reconsidered.
 */
const EXPECTED_SHOTS = 86;

/** Click the version chip — through the phone menu below `md`, where the rail is folded away — and wait until the drawer is drawn and settled. */
async function openReleases(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (await menu.isVisible()) await menu.click();
  await page.locator('.rel-chip').click();
  await expect(page.locator('.rel-drawer')).toBeVisible();
  await expect.poll(() => isReady(page), { timeout: 5000, message: 'the releases drawer never settled' }).toBe(true);
}

const title = (c: ShotCase): string => `${c.section} · ${c.theme} · ${c.width} · ${c.kind}`;

test('the matrix holds the expected number of shots', () => {
  expect(CASES.length).toBe(EXPECTED_SHOTS);
});

for (const c of CASES) {
  test(title(c), async ({ page }) => {
    await stage(page, c);
    if (c.kind === 'releases') await openReleases(page);
    // The drawer is `position: fixed`, so its shots are the viewport: a full-page shot would append the board scrolled out beneath it.
    await expect(page).toHaveScreenshot(title(c).replaceAll(' · ', '-') + '.png', { fullPage: c.kind !== 'releases' });
  });
}
