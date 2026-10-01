/**
 * The shapes the Git sub-view can take, and which of them a narrow window may draw. Mirrors `Layout`, `WIDE_ONLY_LAYOUTS` and `drawableLayout` in
 * `filterSort.ts` rather than reusing them: Sessions' shapes are a different set, and a shared list would make every Git switcher change a Sessions change.
 *
 * The choice persists per device under `management.gitLayout` (an OWNED_KEYS entry, so Reset sweeps it), default `cards`; there is no Settings picker for it.
 */
export type GitLayout = 'cards' | 'table' | 'triage';

export const GIT_LAYOUTS: { key: GitLayout; label: string }[] = [
  { key: 'cards', label: 'Cards' },
  { key: 'table', label: 'Table' },
  { key: 'triage', label: 'Triage' },
];

export const DEFAULT_GIT_LAYOUT: GitLayout = 'cards';

export function isGitLayout(v: unknown): v is GitLayout {
  return GIT_LAYOUTS.some(l => l.key === v);
}

/** The table's five columns do not survive a phone measure, so a narrow window is not offered it (the cards shape drops its bar instead). */
export const WIDE_ONLY_GIT_LAYOUTS: readonly GitLayout[] = ['table'];

/** The switcher's buttons at this width. */
export function gitLayoutsFor(narrow: boolean): { key: GitLayout; label: string }[] {
  return narrow ? GIT_LAYOUTS.filter(l => !WIDE_ONLY_GIT_LAYOUTS.includes(l.key)) : GIT_LAYOUTS;
}

/**
 * The shape actually drawn at this width. Only the render is coerced: the stored choice keeps saying `table`, so widening the window brings the table back.
 */
export function drawableGitLayout(layout: GitLayout, narrow: boolean): GitLayout {
  return narrow && WIDE_ONLY_GIT_LAYOUTS.includes(layout) ? DEFAULT_GIT_LAYOUT : layout;
}
