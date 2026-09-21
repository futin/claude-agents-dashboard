import type { AnalyticsReport } from '../../../shared/types';
import type { SortDir } from './filterSort';

export type { SortDir };

export interface AnalyticsWindow {
  key: string;
  label: string;
  /** Max age in days; undefined = no bound ("Any time"). */
  days?: number;
}

/**
 * Recency filter options. `loggedAt` is a date string (YYYY-MM-DD, no
 * time-of-day), so buckets are day-granular — the Sessions "15 min / 1 hour"
 * windows don't apply here.
 */
export const ANALYTICS_WINDOWS: AnalyticsWindow[] = [
  { key: 'all', label: 'Any time' },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 }
];

/**
 * Which shape draws the log. Two, and they are the Sessions shapes of the same
 * names: the split (the log on the left, one report open beside it) and tiles
 * (every report a metric card, the open one spanning two columns). Tiles was
 * one of the four artboards drawn and dropped when the section was built
 * (`docs/guides/mockups/redesign-mock.html`); it earns a place as the second
 * shape rather than the only one.
 */
export type AnLayout = 'split' | 'tiles';

export const AN_LAYOUTS: { key: AnLayout; label: string }[] = [
  { key: 'split', label: 'Split' },
  { key: 'tiles', label: 'Tiles' }
];

/** The shape a fresh browser opens in — the one the section has always drawn. */
export const DEFAULT_AN_LAYOUT: AnLayout = 'split';

/** Guards the persisted key: a stored value from an older build is not a shape. */
export function isAnLayout(v: unknown): v is AnLayout {
  return AN_LAYOUTS.some(l => l.key === v);
}

/**
 * The shape a phone is not offered.
 *
 * Split is a two-pane master/detail and a 375px measure has no room for the
 * detail pane to be a pane — the same reason `WIDE_ONLY_LAYOUTS` withholds it
 * on the Sessions board. Tiles is a single-column stack there by design.
 */
export const WIDE_ONLY_AN_LAYOUTS: readonly AnLayout[] = ['split'];

/** The switcher's buttons at this width — both shapes, or the one that fits. */
export function anLayoutsFor(narrow: boolean): { key: AnLayout; label: string }[] {
  return narrow ? AN_LAYOUTS.filter(l => !WIDE_ONLY_AN_LAYOUTS.includes(l.key)) : AN_LAYOUTS;
}

/**
 * The shape actually drawn at this width. The choice itself is left alone —
 * `dashboard.analyticsLayout` goes on saying `split` while a narrow window
 * draws tiles, so widening it comes back to the shape you were using.
 */
export function drawableAnLayout(layout: AnLayout, narrow: boolean): AnLayout {
  return narrow && WIDE_ONLY_AN_LAYOUTS.includes(layout) ? 'tiles' : layout;
}

export type AnSortKey = 'recency' | 'tokens' | 'project';

/** Sort-key label in the toolbar's popover and its `Sort: <b>…</b>` readout. */
export const AN_SORT_LABEL: Record<AnSortKey, string> = {
  recency: 'Recency',
  tokens: 'Tokens',
  project: 'Project'
};

/** One-line hint under each sort key — what the order actually means. */
export const AN_SORT_HINT: Record<AnSortKey, string> = {
  recency: 'when /kaizen logged it',
  tokens: 'billable; a gone transcript sorts as 0',
  project: 'A → Z'
};

export interface AnalyticsView {
  /** Selected project names; empty = all projects. */
  projects: string[];
  /** Selected model ids; empty = all models. */
  models: string[];
  /** ANALYTICS_WINDOWS key. */
  window: string;
  sortKey: AnSortKey;
  sortDir: SortDir;
}

/** Default view = current behavior (recency, newest first, no filters). */
export const DEFAULT_ANALYTICS_VIEW: AnalyticsView = {
  projects: [],
  models: [],
  window: 'all',
  sortKey: 'recency',
  sortDir: 'desc'
};

/**
 * How many facets are narrowing the list — the number on the toolbar's filter
 * button. Each facet counts once however many values it holds, matching the
 * Sessions toolbar: the button says "something is hidden", not "how much".
 */
export function analyticsFilterCount(view: AnalyticsView): number {
  return (view.projects.length ? 1 : 0) + (view.models.length ? 1 : 0) + (view.window !== 'all' ? 1 : 0);
}

/**
 * Reset the three filter facets, keeping the sort. Returns `view` itself when
 * nothing is active, so a caller can compare by reference — the same
 * convention `clearFilters` follows on the Sessions side.
 */
export function clearAnalyticsFilters(view: AnalyticsView): AnalyticsView {
  if (analyticsFilterCount(view) === 0) return view;
  return { ...view, projects: [], models: [], window: 'all' };
}

/** Sorted unique project names present in the report list. */
export function distinctProjects(reports: AnalyticsReport[]): string[] {
  return Array.from(new Set(reports.map(r => r.project))).sort((a, b) => a.localeCompare(b));
}

/** Sorted unique model ids across all reports. */
export function distinctModels(reports: AnalyticsReport[]): string[] {
  return Array.from(new Set(reports.flatMap(r => r.models))).sort((a, b) => a.localeCompare(b));
}

/** Billable-token size of a report; missing analysis sorts as 0. */
function tokensOf(r: AnalyticsReport): number {
  return r.analysis?.totals.billableApprox ?? 0;
}

/** Compare two reports by the given key. Ascending; caller flips for desc. */
function compare(a: AnalyticsReport, b: AnalyticsReport, key: AnSortKey): number {
  switch (key) {
    case 'tokens': return tokensOf(a) - tokensOf(b);
    case 'project': return a.project.localeCompare(b.project);
    case 'recency':
    default: return a.loggedAt.localeCompare(b.loggedAt);
  }
}

/** Filter (project, model, time window) then sort. Pure — no mutation. */
export function applyAnalyticsView(
  reports: AnalyticsReport[],
  view: AnalyticsView,
  nowMs: number
): AnalyticsReport[] {
  const win = ANALYTICS_WINDOWS.find(w => w.key === view.window);
  const minMs = win && win.days !== undefined ? nowMs - win.days * 24 * 60 * 60_000 : undefined;

  const filtered = reports.filter(r => {
    if (view.projects.length && !view.projects.includes(r.project)) return false;
    if (view.models.length && !r.models.some(m => view.models.includes(m))) return false;
    if (minMs !== undefined) {
      const loggedMs = Date.parse(r.loggedAt);
      // Unparseable date fails open (kept); otherwise drop anything older than the window.
      if (!Number.isNaN(loggedMs) && loggedMs < minMs) return false;
    }
    return true;
  });

  const dir = view.sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => dir * compare(a, b, view.sortKey));
}
