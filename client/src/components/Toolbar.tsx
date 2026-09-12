import { useCallback, useRef, useState } from 'react';

import type { Session } from '../../../shared/types';
import {
  ACTIVITY_WINDOWS,
  LAYOUTS,
  SORT_HINT,
  SORT_LABEL,
  STATUS_LABEL,
  clearFilters,
  distinctProjects,
  filterCount,
  type Layout,
  type SortKey,
  type View
} from '../lib/filterSort';
import { Popover, useDismiss } from './Popover';

const STATUSES: Session['status'][] = ['working', 'question', 'incomplete', 'idle'];
const SORTS: SortKey[] = ['recency', 'tokens', 'name', 'status'];

type Open = 'filter' | 'sort' | null;

/**
 * One row: the view switcher on the left with its labels; on the right one
 * shared track holding the filter button, the sort label and the sort button.
 * Both buttons open a popover; only one is open at a time. The filter button
 * is raised (paper on the track) only while a filter is set, so the raised
 * state means "something is hidden", not "this is a button".
 *
 * Nothing here does anything but change which rows you see, in what order, and
 * in what shape. What is true of the whole board lives in the aside cards.
 */
export function Toolbar({ sessions, view, onChange, layout, onLayout }: {
  sessions: Session[];
  view: View;
  onChange: (v: View) => void;
  /** Which shape is drawing the list. Owned by `SessionsView`, not by `view` —
      it is seeded from Settings › Display and never persisted. */
  layout: Layout;
  onLayout: (l: Layout) => void;
}) {
  const [open, setOpen] = useState<Open>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(null), []);
  useDismiss(wrap, open !== null, close);

  const set = (patch: Partial<View>) => onChange({ ...view, ...patch });
  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  const n = filterCount(view);

  return (
    <div className="toolbar">
      <div className="seg view" role="tablist" aria-label="View">
        {LAYOUTS.map(l => (
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
          <span className="sortlab">Sort: <b>{SORT_LABEL[view.sortKey]}</b> ({view.sortDir})</span>
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
              <button type="button" className="clear" disabled={n === 0} onClick={() => onChange(clearFilters(view))}>Clear all</button>
            </div>
            <div className="pop-k">Project</div>
            <div className="picks">
              <button type="button" className={`pick${view.projects.length ? '' : ' on'}`} onClick={() => set({ projects: [] })}>All projects</button>
              {distinctProjects(sessions).map(p => (
                <button key={p} type="button" className={`pick${view.projects.includes(p) ? ' on' : ''}`} onClick={() => set({ projects: toggleIn(view.projects, p) })}>{p}</button>
              ))}
            </div>
            <div className="pop-k">Status <span className="hint">· none picked = all</span></div>
            <div className="picks">
              {STATUSES.map(st => (
                <button key={st} type="button" className={`pick${view.statuses.includes(st) ? ' on' : ''}`} onClick={() => set({ statuses: toggleIn(view.statuses, st) })}>
                  <i className={`sdot ${st}`} aria-hidden="true" />{STATUS_LABEL[st]}
                </button>
              ))}
            </div>
            <div className="pop-k">Active in the last</div>
            <div className="sw">
              {ACTIVITY_WINDOWS.map(w => (
                <button key={w.key} type="button" className={view.window === w.key ? 'on' : ''} onClick={() => set({ window: w.key })}>
                  {w.key === 'all' ? 'any time' : w.label.replace(/^Last /, '')}
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
                {SORT_LABEL[k]}<span className="hint">{SORT_HINT[k]}</span>
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
