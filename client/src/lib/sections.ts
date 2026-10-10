/**
 * sections.ts — the top-level sections, in rail order.
 *
 * Lives in `lib/` rather than in `SideRail.tsx` because `lib/settings.ts`
 * needs the list at runtime (the landing picker and its validator are both
 * derived from it) and `test/client-settings.test.ts` imports that module in
 * plain Node — a `.tsx` component would drag `react/jsx-runtime` into a
 * node-assert test's import graph. No JSX, no imports.
 */

export type Section = 'sessions' | 'usage' | 'management' | 'configs' | 'analytics' | 'settings';

/** The rail's own order — it is also the order the landing picker offers. */
export const SECTIONS: { id: Section; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
  { id: 'management', label: 'Management' },
  { id: 'configs', label: 'Claude Configs' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' }
];

/** Whether a stored/persisted string still names a section this build has. */
export function isSection(v: unknown): v is Section {
  return SECTIONS.some(s => s.id === v);
}

/**
 * The `.wrap` classes a section's page renders inside. Analytics alone is an app shell: `wide` pins it to the viewport at xl and its tab is the scroller.
 * Configs and Management want the same width but scroll as a page — neither has an inner scroller, so pinned they overflow `.main` and everything past the
 * fold stops taking clicks (#194) — and `wide-mgmt` is what opts them out of the pinning. Settings, Sessions and Usage get `broad`: width only.
 */
export function wrapClass(section: Section): string {
  if (section === 'analytics') return 'wrap wide';
  if (section === 'configs' || section === 'management') return 'wrap wide wide-mgmt';
  return section === 'settings' || section === 'sessions' || section === 'usage' ? 'wrap broad' : 'wrap';
}
