import type { Session } from '../../../shared/types';

/** Human labels for each status. Shared by the session views and the Toolbar. */
export const STATUS_LABEL: Record<Session['status'], string> = {
  working: 'working',
  idle: 'idle',
  question: 'waiting',
  incomplete: 'pending'
};

/**
 * Urgency weight for the "status" sort key — higher = more urgent. Descending
 * sort (the default dir) surfaces question → working → incomplete → idle, so
 * "desc = most important first" matches tokens/recency.
 */
export const STATUS_ORDER: Record<Session['status'], number> = {
  question: 3,
  working: 2,
  incomplete: 1,
  idle: 0
};

export interface ActivityWindow {
  key: string;
  label: string;
  /** Max age in ms; undefined = no bound ("Any time"). */
  ms?: number;
}

/** Activity-recency filter options. `all` = no bound. */
export const ACTIVITY_WINDOWS: ActivityWindow[] = [
  { key: 'all', label: 'Any time' },
  { key: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { key: '1h', label: 'Last 1 hour', ms: 60 * 60_000 },
  { key: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60_000 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 }
];

export type SortKey = 'recency' | 'tokens' | 'name' | 'status';
export type SortDir = 'asc' | 'desc';

/** What the sort popover prints for each key, and the toolbar's `Sort: …` label. */
export const SORT_LABEL: Record<SortKey, string> = {
  recency: 'Recency',
  tokens: 'Tokens',
  name: 'Name',
  status: 'Status'
};

/** One-line hint under each sort key in the popover — what the order means. */
export const SORT_HINT: Record<SortKey, string> = {
  recency: 'last activity',
  tokens: 'context used',
  name: 'project, A → Z',
  status: 'waiting → working → pending → idle'
};

/**
 * The five shapes the same filtered, sorted list can take. The view switcher
 * lists them in this order; the mock's default is the board.
 *
 * Deliberately NOT part of `View` below: the shape is not a filter, and it is
 * not persisted with one. Which shape the page opens in is the per-device
 * `defaultLayout` setting (`lib/settings.ts`); the switcher's own choice is
 * remembered under its own key (`dashboard.layout`), which `defaultLayout:
 * 'last'` reads and any other value ignores — exactly how `landing` and
 * `dashboard.section` pair up. See docs/subsystems/view-persistence.md.
 */
export type Layout = 'board' | 'list' | 'split' | 'tiles' | 'triage';

export const LAYOUTS: { key: Layout; label: string }[] = [
  { key: 'board', label: 'Board' },
  { key: 'list', label: 'List' },
  { key: 'split', label: 'Split' },
  { key: 'tiles', label: 'Tiles' },
  { key: 'triage', label: 'Triage' }
];

/**
 * The shape a fresh browser opens in, and the fallback when `defaultLayout` is
 * `last` but nothing has been stored yet. The board is the mock's default and
 * the switcher's first entry.
 */
export const DEFAULT_LAYOUT: Layout = 'board';

export function isLayout(v: unknown): v is Layout {
  return LAYOUTS.some(l => l.key === v);
}

export interface View {
  /** Selected project names; empty = all projects. */
  projects: string[];
  /** Selected status values; empty = all statuses. */
  statuses: string[];
  /** ActivityWindow key. */
  window: string;
  sortKey: SortKey;
  sortDir: SortDir;
}

/** Default view = current behavior (recency, newest first, no filters). */
export const DEFAULT_VIEW: View = {
  projects: [],
  statuses: [],
  window: 'all',
  sortKey: 'recency',
  sortDir: 'desc'
};

/** Sorted unique project names present in the session list. */
export function distinctProjects(sessions: Session[]): string[] {
  return Array.from(new Set(sessions.map(s => s.project))).sort((a, b) => a.localeCompare(b));
}

/**
 * Drop selected project names the payload no longer contains, so a filter
 * persisted from an earlier visit cannot silently hide every row (see
 * docs/subsystems/view-persistence.md). `describeEmpty` explains the cases this
 * deliberately leaves standing; healing a name that is simply gone is better
 * than explaining it.
 *
 * Rules, in the order they matter:
 * - An empty payload prunes nothing. No sessions is no evidence, not evidence
 *   of absence, and the very first poll of a mount arrives before any rows do.
 * - Names still present survive; only the absent ones go. Pruning the last
 *   survivor yields `[]`, which MultiSelect and applyView both read as
 *   "All projects".
 * - Nothing to prune returns `selected` itself, so a caller can compare by
 *   reference instead of deep-equality to decide whether to write state.
 */
export function pruneProjects(selected: string[], sessions: Session[]): string[] {
  if (!selected.length || !sessions.length) return selected;
  const present = new Set(sessions.map(s => s.project));
  const kept = selected.filter(p => present.has(p));
  return kept.length === selected.length ? selected : kept;
}

/** Compare two sessions by the given key. Ascending; caller flips for desc. */
function compare(a: Session, b: Session, key: SortKey): number {
  switch (key) {
    case 'tokens': return a.tokens - b.tokens;
    case 'name': return a.project.localeCompare(b.project);
    case 'status': return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    case 'recency':
    default: return a.updatedMs - b.updatedMs;
  }
}

/** The three facets of `View` that can hide a row. Sort key/dir cannot. */
export type FilterKey = 'projects' | 'statuses' | 'window';

/**
 * Report order for `culprits` — fixed, so the empty state reads the same way
 * regardless of which facet the user touched last.
 */
const FILTER_KEYS: FilterKey[] = ['projects', 'statuses', 'window'];

/** True = this row survives that one facet. The predicates `applyView` ANDs together. */
function keeps(key: FilterKey, s: Session, view: View, nowMs: number): boolean {
  switch (key) {
    case 'projects': return !view.projects.length || view.projects.includes(s.project);
    case 'statuses': return !view.statuses.length || view.statuses.includes(s.status);
    case 'window': {
      const win = ACTIVITY_WINDOWS.find(w => w.key === view.window);
      return !win || win.ms === undefined || nowMs - s.updatedMs <= win.ms;
    }
  }
}

/** Filter (project, status, activity window) then sort. Pure — no mutation. */
export function applyView(sessions: Session[], view: View, nowMs: number): Session[] {
  const filtered = sessions.filter(s => FILTER_KEYS.every(k => keeps(k, s, view, nowMs)));
  const dir = view.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => dir * compare(a, b, view.sortKey));
}

/** Why the list came out empty — what `applyView`'s return value cannot say. */
export interface EmptyState {
  /** The payload itself held no sessions, so no filter can be responsible. */
  payloadEmpty: boolean;
  /** Rows in the *unfiltered* payload. */
  total: number;
  /** Facets that rejected at least one row, in FILTER_KEYS order. */
  culprits: FilterKey[];
}

/**
 * Explain an empty session list, from the same payload + view + clock
 * `applyView` saw — pass it the UNFILTERED sessions.
 *
 * An empty payload names no filter, however many are set: no rows is no
 * evidence, the same rule `pruneProjects` follows. Each facet is judged on its
 * own, not in sequence, so a filter that rejects nothing is never blamed for a
 * list another one emptied.
 */
export function describeEmpty(sessions: Session[], view: View, nowMs: number): EmptyState {
  if (!sessions.length) return { payloadEmpty: true, total: 0, culprits: [] };
  return {
    payloadEmpty: false,
    total: sessions.length,
    culprits: FILTER_KEYS.filter(k => sessions.some(s => !keeps(k, s, view, nowMs)))
  };
}

/** Whether any facet is hiding rows right now. Sort key/dir do not count. */
export function hasActiveFilters(view: View): boolean {
  return filterCount(view) > 0;
}

/**
 * How many of the three facets are set — the badge on the toolbar's filter
 * button. A facet counts once however many values it holds: two statuses are
 * one filter, not two.
 */
export function filterCount(view: View): number {
  return (view.projects.length ? 1 : 0) + (view.statuses.length ? 1 : 0) + (view.window !== 'all' ? 1 : 0);
}

/**
 * Reset the three filter facets, keeping the sort. Returns `view` itself when
 * nothing is active, so a caller can compare by reference — same convention as
 * `pruneProjects`.
 */
export function clearFilters(view: View): View {
  if (!hasActiveFilters(view)) return view;
  return { ...view, projects: [], statuses: [], window: 'all' };
}
