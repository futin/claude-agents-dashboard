/**
 * The shapes the Git sub-view can take, and which of them a narrow window may draw. Mirrors `Layout`, `WIDE_ONLY_LAYOUTS` and `drawableLayout` in
 * `filterSort.ts` rather than reusing them: Sessions' shapes are a different set, and a shared list would make every Git switcher change a Sessions change.
 *
 * Four shapes: Inbox, Matrix, Inspector, Branches. The choice persists per device under `management.gitLayout` (an OWNED_KEYS entry, so Reset sweeps it),
 * default `inbox`; there is no Settings picker for it. A stored `cards`, `table` or `triage` from the old three-shape switcher, or any other unknown value,
 * reads as `inbox` through `parseGitLayout`. Matrix is wide-only: a phone draws Inbox for a stored Matrix, and the stored choice survives for a wider window.
 */
export type GitLayout = 'inbox' | 'matrix' | 'inspector' | 'branches';

export const GIT_LAYOUTS: { key: GitLayout; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'matrix', label: 'Matrix' },
  { key: 'inspector', label: 'Inspector' },
  { key: 'branches', label: 'Branches' },
];

export const DEFAULT_GIT_LAYOUT: GitLayout = 'inbox';

export function isGitLayout(v: unknown): v is GitLayout {
  return GIT_LAYOUTS.some(l => l.key === v);
}

/** The keys the previous switcher stored. They are not layouts any more; `parseGitLayout` folds them into the default. */
export const LEGACY_GIT_LAYOUTS = ['cards', 'table', 'triage'] as const;

/** A stored value read as a layout: a current key stands for itself, anything else (the legacy keys included) is the default. */
export function parseGitLayout(v: unknown): GitLayout {
  return isGitLayout(v) ? v : DEFAULT_GIT_LAYOUT;
}

/** The matrix table has a 760px floor, so a phone measure cannot hold it and a narrow window is not offered it. */
export const WIDE_ONLY_GIT_LAYOUTS: readonly GitLayout[] = ['matrix'];

/** The switcher's buttons at this width. */
export function gitLayoutsFor(narrow: boolean): { key: GitLayout; label: string }[] {
  return narrow ? GIT_LAYOUTS.filter(l => !WIDE_ONLY_GIT_LAYOUTS.includes(l.key)) : GIT_LAYOUTS;
}

/**
 * The shape actually drawn at this width. Only the render is coerced: the stored choice keeps saying `matrix`, so widening the window brings the matrix back.
 */
export function drawableGitLayout(layout: GitLayout, narrow: boolean): GitLayout {
  return narrow && WIDE_ONLY_GIT_LAYOUTS.includes(layout) ? DEFAULT_GIT_LAYOUT : layout;
}
