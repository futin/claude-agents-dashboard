/**
 * The shapes the CodeGraph sub-view can take, and which of them a narrow window may draw. The same contract as `gitLayouts.ts`, kept as its own list so a Git
 * switcher change is never a CodeGraph change.
 *
 * Three shapes: Inbox, Matrix, Inspector. The choice persists per device under `management.codegraphLayout` (an OWNED_KEYS entry, so Reset sweeps it), default
 * `inbox`. Matrix is wide-only: a phone draws Inbox for a stored Matrix, and the stored choice survives for a wider window. A key Git has but this view does not
 * (`branches`) reads as `inbox` through `parseCodegraphLayout`.
 */
export type CodegraphLayout = 'inbox' | 'matrix' | 'inspector';

export const CODEGRAPH_LAYOUTS: { key: CodegraphLayout; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'matrix', label: 'Matrix' },
  { key: 'inspector', label: 'Inspector' },
];

export const DEFAULT_CODEGRAPH_LAYOUT: CodegraphLayout = 'inbox';

export function isCodegraphLayout(v: unknown): v is CodegraphLayout {
  return CODEGRAPH_LAYOUTS.some(l => l.key === v);
}

/** A stored value read as a layout: a current key stands for itself, anything else is the default. */
export function parseCodegraphLayout(v: unknown): CodegraphLayout {
  return isCodegraphLayout(v) ? v : DEFAULT_CODEGRAPH_LAYOUT;
}

/** The matrix table has a 760px floor, so a phone measure cannot hold it and a narrow window is not offered it. */
export const WIDE_ONLY_CODEGRAPH_LAYOUTS: readonly CodegraphLayout[] = ['matrix'];

/** The switcher's buttons at this width. */
export function codegraphLayoutsFor(narrow: boolean): { key: CodegraphLayout; label: string }[] {
  return narrow ? CODEGRAPH_LAYOUTS.filter(l => !WIDE_ONLY_CODEGRAPH_LAYOUTS.includes(l.key)) : CODEGRAPH_LAYOUTS;
}

/** The shape actually drawn at this width. Only the render is coerced: the stored choice keeps saying `matrix`, so widening the window brings it back. */
export function drawableCodegraphLayout(layout: CodegraphLayout, narrow: boolean): CodegraphLayout {
  return narrow && WIDE_ONLY_CODEGRAPH_LAYOUTS.includes(layout) ? DEFAULT_CODEGRAPH_LAYOUT : layout;
}
