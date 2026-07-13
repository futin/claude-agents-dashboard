import type { AnalyticsReport } from '../../../../shared/types';
import {
  ANALYTICS_WINDOWS,
  distinctModels,
  distinctProjects,
  type AnSortKey,
  type AnalyticsView
} from '../../lib/analyticsFilterSort';
import { MultiSelect } from '../MultiSelect';

const SORTS: { key: AnSortKey; label: string }[] = [
  { key: 'recency', label: 'Recency' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'project', label: 'Project' }
];

/** Filter + sort control bar for Analytics. Mirrors the Sessions Toolbar; state lives in the parent. */
export function AnalyticsToolbar({
  reports,
  view,
  onChange
}: {
  reports: AnalyticsReport[];
  view: AnalyticsView;
  onChange: (v: AnalyticsView) => void;
}) {
  const projects = distinctProjects(reports);
  const models = distinctModels(reports);
  const set = (patch: Partial<AnalyticsView>) => onChange({ ...view, ...patch });

  return (
    <div className="toolbar">
      <MultiSelect
        label="projects"
        options={projects.map(p => ({ value: p, label: p }))}
        selected={view.projects}
        onChange={projects => set({ projects })}
      />

      <MultiSelect
        label="models"
        options={models.map(m => ({ value: m, label: m }))}
        selected={view.models}
        onChange={models => set({ models })}
      />

      <select value={view.window} onChange={e => set({ window: e.target.value })} title="Logged">
        {ANALYTICS_WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
      </select>

      <span className="tb-spacer" />

      <select
        value={view.sortKey}
        onChange={e => set({ sortKey: e.target.value as AnSortKey })}
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
