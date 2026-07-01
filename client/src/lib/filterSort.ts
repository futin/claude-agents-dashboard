import type { Session } from '../../../shared/types';

/** Human labels for each status. Shared by SessionRow and the Toolbar. */
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

export interface View {
  /** Project name, or 'all'. */
  project: string;
  /** Status value, or 'all'. */
  status: string;
  /** ActivityWindow key. */
  window: string;
  sortKey: SortKey;
  sortDir: SortDir;
}

/** Default view = current behavior (recency, newest first, no filters). */
export const DEFAULT_VIEW: View = {
  project: 'all',
  status: 'all',
  window: 'all',
  sortKey: 'recency',
  sortDir: 'desc'
};

/** Sorted unique project names present in the session list. */
export function distinctProjects(sessions: Session[]): string[] {
  return Array.from(new Set(sessions.map(s => s.project))).sort((a, b) => a.localeCompare(b));
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

/** Filter (project, status, activity window) then sort. Pure — no mutation. */
export function applyView(sessions: Session[], view: View, nowMs: number): Session[] {
  const win = ACTIVITY_WINDOWS.find(w => w.key === view.window);
  const filtered = sessions.filter(s => {
    if (view.project !== 'all' && s.project !== view.project) return false;
    if (view.status !== 'all' && s.status !== view.status) return false;
    if (win && win.ms !== undefined && nowMs - s.updatedMs > win.ms) return false;
    return true;
  });
  const dir = view.sortDir === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => dir * compare(a, b, view.sortKey));
}
