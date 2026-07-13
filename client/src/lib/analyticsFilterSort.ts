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

export type AnSortKey = 'recency' | 'tokens' | 'project';

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
