/**
 * The screenshot matrix (spec §4): every `SECTIONS` view at the six daylight breakpoint tiers (`fixed`), the two full-width tiers (`full`) and the four other
 * themes at 1280, plus one Sessions shot with the chat drawer open. Zero tolerance — the config's `maxDiffPixels: 0` and `threshold: 0` — but for the cases
 * that carry their own `threshold`.
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
  kind: 'shot' | 'detail' | 'triage' | 'git-matrix' | 'git-inspector' | 'git-branches' | 'codegraph-inbox' | 'codegraph-matrix' | 'codegraph-inspector' | 'projects-tiles' | 'projects-columns' | 'projects-lists' | 'routines-runs' | 'releases';
  /** Per-pixel colour tolerance overriding the config's `0`; `maxDiffPixels` stays `0`, so a pixel that really changes colour still fails the shot. */
  threshold?: number;
  /** Selectors painted over before the comparison, for a native control whose glyphs Chromium places a pixel apart at random. */
  mask?: string[];
}

/**
 * Chromium rasterises the top-left rounded corner of the projects filter (`.pj-toolbar .pin-filter`, at a fractional y) two ways at random: the same 7
 * pixels, every channel off by at most 1, in about 60% of runs (#235). Layout is identical in both, and neither an extra settled frame nor a whole-pixel left
 * edge removes it, so the 1280 projects shots accept one-step colour noise — about 0.004 in pixelmatch's YIQ scale, 0.01 leaves a little headroom.
 */
const AA_NOISE = 0.01;

/**
 * Two shots see wider noise from the same quirk, depending on what the shared browser drew before them: the Git Matrix at 1280 (rounded corners and status
 * dots) and Configs daylight 1921 (the `↻` refresh glyph, drawn in a system fallback face). Channel differences reach 8, which needs a pixelmatch threshold of
 * 0.0227 (measured 2026-10-26 from the 2026-10-24 git-matrix failure); 0.03 leaves headroom and still fails a real token change (#282).
 */
const AA_NOISE_WIDE = 0.03;

/**
 * Routines hits the same quirk: its stats band (`.rtn-stats`, rounded and `overflow: hidden`, at a fractional y) shows one-step noise on its corners in
 * some runs, so every Routines shot takes `AA_NOISE`. The phone Runs shot also masks the native job `<select>`: at y 184.69 Chromium draws its label a whole
 * pixel lower in about half the runs, a shift no colour tolerance absorbs. The 1280 Runs shot still pins the select.
 */
const ROUTINES = (c: ShotCase): ShotCase => (c.section === 'routines' ? { ...c, threshold: AA_NOISE } : c);

/** Only the one Configs shot whose refresh glyph flakes takes `AA_NOISE_WIDE`; every other Configs shot stays at zero tolerance. */
const CONFIGS_1921 = (c: ShotCase): ShotCase =>
  c.section === 'configs' && c.theme === 'daylight' && c.width === 1921 && c.kind === 'shot' ? { ...c, threshold: AA_NOISE_WIDE } : c;

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
const CG = {
  section: 'management' as Section,
  theme: 'daylight' as ThemeId,
  contentWidth: 'fixed' as const,
  managementTab: 'codegraph' as const
};
const PROJ = {
  section: 'management' as Section,
  theme: 'daylight' as ThemeId,
  contentWidth: 'fixed' as const,
  managementTab: 'projects' as const,
  fixtures: { '/api/pins': pinsWithGone }
};

const CASES: ShotCase[] = [
  ...SECTIONS.flatMap((s) => casesFor(s.id)).map(ROUTINES).map(CONFIGS_1921),
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' },
  // The phone drawer folds the fixture plan's card to one `Plan 7/13 · …` line; the 1280 detail above pins its ellipsised `Plan · …` head.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' },
  // Triage draws its Working and Idle rows without `Tags`, so the task pill there has its own render site to pin.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', layout: 'triage', kind: 'triage' },
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', layout: 'triage', kind: 'triage' },
  // Git's default layout (Inbox) is what the management shots above show; the other layouts are seeded through the persisted key. The sessions fixture adds
  // an idle session on lumen-cli so the join draws all three chips.
  { ...GIT, width: 1280, storage: { 'management.gitLayout': 'matrix' }, kind: 'git-matrix', threshold: AA_NOISE_WIDE },
  { ...GIT, width: 375, storage: { 'management.gitLayout': 'inspector' }, kind: 'git-inspector' },
  { ...GIT, width: 1280, storage: { 'management.gitLayout': 'inspector' }, kind: 'git-inspector' },
  { ...GIT, width: 375, storage: { 'management.gitLayout': 'branches' }, kind: 'git-branches' },
  { ...GIT, width: 1280, storage: { 'management.gitLayout': 'branches' }, kind: 'git-branches' },
  // CodeGraph's Inbox is the default layout and drawn at 1280; the phone shot stores Matrix, which a narrow window does not offer, so it also pins that the
  // stored choice is drawn as Inbox rather than a table the phone cannot hold.
  { ...CG, width: 1280, kind: 'codegraph-inbox' },
  { ...CG, width: 1280, storage: { 'management.codegraphLayout': 'matrix' }, kind: 'codegraph-matrix' },
  { ...CG, width: 1280, storage: { 'management.codegraphLayout': 'inspector' }, kind: 'codegraph-inspector' },
  { ...CG, width: 375, storage: { 'management.codegraphLayout': 'matrix' }, kind: 'codegraph-inbox' },
  // Projects with a pinned folder that is gone, so every layout shows the `Folder gone` chip.
  { ...PROJ, width: 1280, storage: { 'management.projectsLayout': 'tiles' }, kind: 'projects-tiles', threshold: AA_NOISE },
  { ...PROJ, width: 1280, storage: { 'management.projectsLayout': 'columns' }, kind: 'projects-columns', threshold: AA_NOISE },
  { ...PROJ, width: 375, storage: { 'management.projectsLayout': 'lists' }, kind: 'projects-lists' },
  // Routines' default page (Jobs) is what the matrix above shows; Runs is the rail's other sub-item.
  { section: 'routines', theme: 'daylight', width: 375, contentWidth: 'fixed', routinesTab: 'runs', kind: 'routines-runs', threshold: AA_NOISE, mask: ['.rtn-select'] },
  { section: 'routines', theme: 'daylight', width: 1280, contentWidth: 'fixed', routinesTab: 'runs', kind: 'routines-runs', threshold: AA_NOISE },
  // What's new, opened from the version chip: full screen on the phone (reached through the menu, whose last row the chip is), the 400px panel from `md`.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', kind: 'releases' },
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', kind: 'releases' }
];

/**
 * 12 per view × 7 views + 2 drawer details + 2 triage + 5 git layouts + 4 codegraph layouts + 3 projects layouts + 2 routines runs + 2 What's new drawers. A changed `SECTIONS` fails here until the
 * matrix (and its baselines) are reconsidered.
 */
const EXPECTED_SHOTS = 104;

/** Click the version chip — through the phone menu below `md`, where the rail is folded away — and wait until the drawer is drawn and settled. */
async function openReleases(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (await menu.isVisible()) await menu.click();
  await page.locator('.rel-chip .uk-chip').click();
  await expect(page.locator('.uk-drawer')).toBeVisible();
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
    await expect(page).toHaveScreenshot(title(c).replaceAll(' · ', '-') + '.png', {
      fullPage: c.kind !== 'releases',
      ...(c.threshold !== undefined && { threshold: c.threshold }),
      ...(c.mask && { mask: c.mask.map((s) => page.locator(s)) })
    });
  });
}
