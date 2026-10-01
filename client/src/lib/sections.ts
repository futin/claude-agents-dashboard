/**
 * sections.ts — the top-level sections, in rail order.
 *
 * Lives in `lib/` rather than in `SideRail.tsx` because `lib/settings.ts`
 * needs the list at runtime (the landing picker and its validator are both
 * derived from it) and `test/client-settings.test.ts` imports that module in
 * plain Node — a `.tsx` component would drag `react/jsx-runtime` into a
 * node-assert test's import graph. No JSX, no imports.
 */

export type Section = 'sessions' | 'usage' | 'configs' | 'analytics' | 'settings';

/** The rail's own order — it is also the order the landing picker offers. */
export const SECTIONS: { id: Section; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
  { id: 'configs', label: 'Claude Configs' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' }
];

/** Whether a stored/persisted string still names a section this build has. */
export function isSection(v: unknown): v is Section {
  return SECTIONS.some(s => s.id === v);
}
