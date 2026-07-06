import type { Session } from '../../../shared/types';
import {
  ACTIVITY_WINDOWS,
  STATUS_LABEL,
  distinctProjects,
  type SortKey,
  type View
} from '../lib/filterSort';
import { MultiSelect } from './MultiSelect';

const STATUSES: Session['status'][] = ['working', 'question', 'incomplete', 'idle'];

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'recency', label: 'Recency' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' }
];

/** Filter + sort control bar. Multi-select project/status facets; state lives in the parent. */
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
      <MultiSelect
        label="projects"
        options={projects.map(p => ({ value: p, label: p }))}
        selected={view.projects}
        onChange={projects => set({ projects })}
      />

      <MultiSelect
        label="statuses"
        options={STATUSES.map(s => ({ value: s, label: STATUS_LABEL[s] }))}
        selected={view.statuses}
        onChange={statuses => set({ statuses })}
      />

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
