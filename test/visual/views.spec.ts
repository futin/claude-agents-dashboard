/**
 * The screenshot matrix (spec §4): every `SECTIONS` view at the six daylight breakpoint tiers (`fixed`), the two full-width tiers (`full`) and the four other
 * themes at 1280, plus one Sessions shot with the chat drawer open. Zero tolerance — the config's `maxDiffPixels: 0` and `threshold: 0`.
 */
import { SECTIONS, type Section } from '../../client/src/lib/sections.js';
import type { ThemeId } from '../../client/src/lib/settings.js';

import { FIXTURE_SESSION_ID } from './fixtures/index.js';
import { expect, test } from './harness.js';
import { stage, type StageOpts } from './stage.js';
import { DAYLIGHT_TIERS } from './tiers.js';

interface ShotCase extends StageOpts {
  kind: 'shot' | 'detail' | 'triage';
}

const OTHER_THEMES: ThemeId[] = ['midnight', 'amber', 'graphite', 'nightshift'];

function casesFor(section: Section): ShotCase[] {
  return [
    ...DAYLIGHT_TIERS.map((t) => ({ section, theme: 'daylight' as ThemeId, ...t, kind: 'shot' as const })),
    ...OTHER_THEMES.map((theme) => ({ section, theme, width: 1280, contentWidth: 'fixed' as const, kind: 'shot' as const }))
  ];
}

const CASES: ShotCase[] = [
  ...SECTIONS.flatMap((s) => casesFor(s.id)),
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' },
  // The phone drawer folds the fixture plan's card to one `Plan 7/13 · …` line; the 1280 detail above pins its ellipsised `Plan · …` head.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' },
  // Triage draws its Working and Idle rows without `Tags`, so the task pill there has its own render site to pin.
  { section: 'sessions', theme: 'daylight', width: 375, contentWidth: 'fixed', layout: 'triage', kind: 'triage' },
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', layout: 'triage', kind: 'triage' }
];

/** 12 per view × 6 views + 2 drawer details + 2 triage. A changed `SECTIONS` fails here until the matrix (and its baselines) are reconsidered. */
const EXPECTED_SHOTS = 76;

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
