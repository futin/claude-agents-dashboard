import { useCallback, useRef, useState } from 'react';

import type { AnalyticsReport } from '../../../../shared/types';
import {
  ANALYTICS_WINDOWS,
  anLayoutsFor,
  AN_SORT_HINT,
  AN_SORT_LABEL,
  analyticsFilterCount,
  clearAnalyticsFilters,
  distinctModels,
  distinctProjects,
  type AnLayout,
  type AnSortKey,
  type AnalyticsView
} from '../../lib/analyticsFilterSort';
import { Popover, useDismiss } from '../Popover';

const SORTS: AnSortKey[] = ['recency', 'tokens', 'project'];

type Open = 'filter' | 'sort' | null;

/**
 * Filter + sort for Analytics, drawn in the Sessions toolbar's language: the
 * shape switcher on the left, then how much of the log is in front of you;
 * on the right one shared track holding the filter button, the sort readout
 * and the sort button. Both buttons open a popover; only one is open at a time.
 *
 * State lives in the parent (the facets persisted under
 * `dashboard.analyticsView`, the shape under `dashboard.analyticsLayout`).
 */
export function AnalyticsToolbar({
  reports,
  shownCount,
  view,
  onChange,
  layout,
  onLayout,
  narrow
}: {
  reports: AnalyticsReport[];
  /** How many reports survived the filter — stated beside the switcher. */
  shownCount: number;
  view: AnalyticsView;
  onChange: (v: AnalyticsView) => void;
  /** Which shape is drawing the log. Owned by `AnalyticsView`, not by `view` —
      it is not a filter. */
  layout: AnLayout;
  onLayout: (l: AnLayout) => void;
  /** Phone measure: the switcher drops the shape that width cannot draw
      (`anLayoutsFor`). Filtered in the markup rather than hidden in CSS — a
      `display:none` button is still a tab stop and still clickable by script. */
  narrow: boolean;
}) {
  const [open, setOpen] = useState<Open>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(null), []);
  useDismiss(wrap, open !== null, close);

  const set = (patch: Partial<AnalyticsView>) => onChange({ ...view, ...patch });
  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  const n = analyticsFilterCount(view);
  const shapes = anLayoutsFor(narrow);

  return (
    <div className="toolbar">
      {/* Dropped outright when this width draws only one shape, rather than
          left as a lone tab that switches to itself — the row is then the
          count and the filter/sort track, which is what it was before the
          switcher existed. */}
      {shapes.length > 1 && (
        <div className="seg view" role="tablist" aria-label="View">
          {shapes.map(l => (
            <button
              key={l.key}
              type="button"
              role="tab"
              aria-selected={layout === l.key}
              className={layout === l.key ? 'on' : ''}
              onClick={() => onLayout(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
      <span className="an-hint">{shownCount} of {reports.length} sessions</span>
      <span className="tb-spacer" />
      <div className="ctlwrap" ref={wrap}>
        <div className="seg ctl">
          <button
            type="button"
            className={`ictl${n ? ' on' : ''}${open === 'filter' ? ' open' : ''}`}
            title="Filters"
            aria-label={n ? `Filters, ${n} set` : 'Filters'}
            aria-haspopup="dialog"
            aria-expanded={open === 'filter'}
            onClick={() => setOpen(o => (o === 'filter' ? null : 'filter'))}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z" /></svg>
            {n > 0 && <span className="n">{n}</span>}
          </button>
          <i className="vsep" aria-hidden="true" />
          <span className="sortlab">Sort: <b>{AN_SORT_LABEL[view.sortKey]}</b> ({view.sortDir})</span>
          <button
            type="button"
            className={`ictl${open === 'sort' ? ' open' : ''}`}
            title="Change sort"
            aria-label="Change sort"
            aria-haspopup="dialog"
            aria-expanded={open === 'sort'}
            onClick={() => setOpen(o => (o === 'sort' ? null : 'sort'))}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4v12M6 16l-2.5-2.5M6 16l2.5-2.5M14 16V4M14 4l-2.5 2.5M14 4l2.5 2.5" /></svg>
          </button>
        </div>

        {open === 'filter' && (
          <Popover label="Filters">
            <div className="pop-h">
              Filters
              <button type="button" className="clear" disabled={n === 0} onClick={() => onChange(clearAnalyticsFilters(view))}>Clear all</button>
            </div>
            <div className="pop-k">Project</div>
            <div className="picks">
              <button type="button" className={`pick${view.projects.length ? '' : ' on'}`} onClick={() => set({ projects: [] })}>All projects</button>
              {distinctProjects(reports).map(p => (
                <button key={p} type="button" className={`pick${view.projects.includes(p) ? ' on' : ''}`} onClick={() => set({ projects: toggleIn(view.projects, p) })}>{p}</button>
              ))}
            </div>
            <div className="pop-k">Model <span className="hint">· a report matches if any of its models does</span></div>
            <div className="picks">
              {distinctModels(reports).map(m => (
                <button key={m} type="button" className={`pick${view.models.includes(m) ? ' on' : ''}`} onClick={() => set({ models: toggleIn(view.models, m) })}>{m}</button>
              ))}
            </div>
            {/* Day-granular: `loggedAt` is a date with no time of day, so the
                Sessions view's 15 min / 1 hour windows have nothing to bite on. */}
            <div className="pop-k">Logged</div>
            <div className="sw">
              {ANALYTICS_WINDOWS.map(w => (
                <button key={w.key} type="button" className={view.window === w.key ? 'on' : ''} onClick={() => set({ window: w.key })}>
                  {w.label.replace('Last ', '')}
                </button>
              ))}
            </div>
          </Popover>
        )}

        {open === 'sort' && (
          <Popover label="Sort by">
            <div className="pop-h">Sort by</div>
            {SORTS.map(k => (
              <button key={k} type="button" className={`opt${view.sortKey === k ? ' on' : ''}`} onClick={() => set({ sortKey: k })}>
                {AN_SORT_LABEL[k]}<span className="hint">{AN_SORT_HINT[k]}</span>
                <svg className="tick" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" /></svg>
              </button>
            ))}
            <div className="pop-div" />
            <div className="sw">
              <button type="button" className={view.sortDir === 'asc' ? 'on' : ''} onClick={() => set({ sortDir: 'asc' })}>Ascending</button>
              <button type="button" className={view.sortDir === 'desc' ? 'on' : ''} onClick={() => set({ sortDir: 'desc' })}>Descending</button>
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}
