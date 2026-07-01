import type { Session } from '../../../shared/types';
import {
  ACTIVITY_WINDOWS,
  STATUS_LABEL,
  distinctProjects,
  type SortKey,
  type View
} from '../lib/filterSort';

const STATUSES: Session['status'][] = ['working', 'question', 'incomplete', 'idle'];

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'recency', label: 'Recency' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' }
];

/** Filter + sort control bar. Single-select facets; state lives in the parent. */
export function Toolbar({
  sessions,
  view,
  onChange
}: {
  sessions: Session[];
  view: View;
  onChange: (v: View) => void;
}) {
  const projects = distinctProjects(sessions);
  const set = (patch: Partial<View>) => onChange({ ...view, ...patch });

  return (
    <div className="toolbar">
      <select value={view.project} onChange={e => set({ project: e.target.value })} title="Project">
        <option value="all">All projects</option>
        {projects.map(p => <option key={p} value={p}>{p}</option>)}
      </select>

      <select value={view.status} onChange={e => set({ status: e.target.value })} title="Status">
        <option value="all">All statuses</option>
        {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>

      <select value={view.window} onChange={e => set({ window: e.target.value })} title="Activity">
        {ACTIVITY_WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
      </select>

      <span className="tb-spacer" />

      <select
        value={view.sortKey}
        onChange={e => set({ sortKey: e.target.value as SortKey })}
        title="Sort by"
      >
        {SORTS.map(s => <option key={s.key} value={s.key}>Sort: {s.label}</option>)}
      </select>

      <button
        className="tb-dir"
        title={view.sortDir === 'desc' ? 'Descending' : 'Ascending'}
        onClick={() => set({ sortDir: view.sortDir === 'desc' ? 'asc' : 'desc' })}
      >
        {view.sortDir === 'desc' ? '↓' : '↑'}
      </button>
    </div>
  );
}
