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
  kind: 'shot' | 'detail';
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
  { section: 'sessions', theme: 'daylight', width: 1280, contentWidth: 'fixed', query: '?session=' + FIXTURE_SESSION_ID, kind: 'detail' }
];

/** 12 per view × 6 views + 1 detail. A changed `SECTIONS` fails here until the matrix (and its baselines) are reconsidered. */
const EXPECTED_SHOTS = 73;

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
