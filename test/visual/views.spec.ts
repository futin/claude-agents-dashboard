/**
 * The screenshot matrix (spec §4): every `SECTIONS` view at the six daylight breakpoint tiers (`fixed`), the two full-width tiers (`full`) and the four other
 * themes at 1280, plus one Sessions shot with the chat drawer open. Zero tolerance — the config's `maxDiffPixels: 0` and `threshold: 0`.
 */
import { SECTIONS, type Section } from '../../client/src/lib/sections.js';
import type { ThemeId } from '../../client/src/lib/settings.js';

import { FIXTURE_SESSION_ID } from './fixtures/index.js';
import { TRACE_IDS } from './fixtures/session-trace.js';
import { gitSessions } from './fixtures/git-sessions.js';
import { pinsWithGone } from './fixtures/pins.js';
import { expect, test } from './harness.js';
import { isReady, stage, type StageOpts } from './stage.js';
import { DAYLIGHT_TIERS } from './tiers.js';

interface ShotCase extends StageOpts {
  kind: 'shot' | 'detail' | 'triage' | 'git-matrix' | 'git-inspector' | 'git-branches' | 'projects-tiles' | 'projects-columns' | 'projects-lists';
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
  { ...PROJ, width: 375, storage: { 'management.projectsLayout': 'lists' }, kind: 'projects-lists' }
];

/** 12 per view × 6 views + 2 drawer details + 2 triage + 5 git layouts + 3 projects layouts = 84 counted shots; the 3 Trace shots (below) sit outside the count. A changed `SECTIONS` fails here until the matrix (and its baselines) are reconsidered. */
const EXPECTED_SHOTS = 84;

/**
 * The drawer's Trace mode with a step picked — not in `CASES`, because each needs a click first. 1280 picks a row (a retry, so the arcs run back to its
 * failure); 375 follows a chat tool line's `why?`; the `fold` shot picks the subagent's Task row, which scrolls turn 1 into view with the Task's run
 * folded shut under it (a pick of the Task itself does not open it): the summary, its six ticks with the red failure, and the lane's elbow.
 */
const TRACE_SHOTS = [
  { width: 1280, pick: 'row' as const, step: 'toolu_11', label: 'row', suffix: '' },
  { width: 375, pick: 'why' as const, step: TRACE_IDS.editLimiter, label: 'why', suffix: '' },
  { width: 1280, pick: 'row' as const, step: 'toolu_04', label: 'fold', suffix: '-fold' }
];

const title = (c: ShotCase): string => `${c.section} · ${c.theme} · ${c.width} · ${c.kind}`;

test('the matrix holds the expected number of shots', () => {
  expect(CASES.length).toBe(EXPECTED_SHOTS);
});

for (const c of CASES) {
  test(title(c), async ({ page }) => {
    await stage(page, c);
    await expect(page).toHaveScreenshot(title(c).replaceAll(' · ', '-') + '.png', { fullPage: true });
  });
}

for (const t of TRACE_SHOTS) {
  const name = `sessions-daylight-${t.width}-trace${t.suffix}`;
  test(`sessions · daylight · ${t.width} · trace (${t.label})`, async ({ page }) => {
    await stage(page, { section: 'sessions', theme: 'daylight', width: t.width, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID });
    const drawer = page.locator('aside.chat');
    if (t.pick === 'why') {
      // The last tool line in the transcript is the Edit of the limiter; its `why?` opens that step in Trace.
      await drawer.locator('.cmsg-tool.has-why').last().getByRole('button', { name: 'why?' }).click();
    } else {
      await drawer.getByRole('tab', { name: 'Trace' }).click();
      await drawer.locator(`[data-trn="${t.step}"]`).click();
    }
    const picked = drawer.locator(`.tr-row.tr-on[data-trn="${t.step}"]`);
    await expect(picked).toBeVisible();
    // The arcs are drawn into the SVG after layout; a picked step with causes has at least one.
    await expect(drawer.locator('.tr-arcs path').first()).toBeAttached();
    if (t.label === 'fold') await expect(drawer.locator('.tr-sum .tr-fold[aria-expanded="false"]')).toBeVisible();
    await expect.poll(() => isReady(page)).toBe(true);
    await expect(page).toHaveScreenshot(name + '.png', { fullPage: true });
  });
}
