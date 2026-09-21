import { useMemo, useState } from 'react';

import { useAnalytics } from '../../hooks/useAnalytics';
import { useNarrow } from '../../hooks/useNarrow';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  applyAnalyticsView,
  clearAnalyticsFilters,
  drawableAnLayout,
  isAnLayout,
  DEFAULT_ANALYTICS_VIEW,
  DEFAULT_AN_LAYOUT,
  type AnLayout,
  type AnalyticsView as AnalyticsViewState
} from '../../lib/analyticsFilterSort';
import { AnalyticsSplit } from './AnalyticsSplit';
import { AnalyticsTiles } from './AnalyticsTiles';
import { AnalyticsToolbar } from './AnalyticsToolbar';

/**
 * Analytics section — the last N sessions the `/kaizen` skill has logged, each
 * pairing its lesson with a live re-run of the deterministic analyzer. Read-only:
 * `/kaizen` is the sole producer (a session appears here only after `/kaizen`
 * logs it to ~/.claude/session-analytics-log.md). Default export → lazy chunk, so the
 * sessions bundle is unaffected.
 *
 * Two shapes, both borrowed from Sessions: the **split** (the log as `.lrow`s,
 * one report open in the `.inspect` card beside it) and **tiles** (every report
 * a metric card carrying its billable total). That is deliberate — the two
 * sections differ in subject, not in kind, so a row's dot carries what became
 * of the lesson where Sessions carries a session's state, and the figure is
 * billable tokens where Sessions shows context used. Tiles was one of four
 * shapes drawn as artboards and dropped when the section was built
 * (`docs/guides/mockups/redesign-mock.html`); it is back as the second shape,
 * and as the only one a phone can draw.
 */
export default function AnalyticsView() {
  const { data, loading, error, refresh } = useAnalytics();
  const reports = data?.reports ?? [];

  const [view, setView] = usePersistedState<AnalyticsViewState>(
    'dashboard.analyticsView',
    DEFAULT_ANALYTICS_VIEW
  );
  const shown = useMemo(() => applyAnalyticsView(reports, view, Date.now()), [reports, view]);

  // The shape gets its own key rather than riding in `view`: it is not a
  // filter. Guarded on read, because a value stored by an older build (or by
  // hand) is not necessarily a shape.
  const [storedLayout, setLayout] = usePersistedState<AnLayout>('dashboard.analyticsLayout', DEFAULT_AN_LAYOUT);
  const layout = isAnLayout(storedLayout) ? storedLayout : DEFAULT_AN_LAYOUT;
  // A phone draws tiles where the choice says split — the split's detail pane
  // has no room to be a pane there. Only the *drawing* is coerced: the stored
  // key keeps the real choice, so widening the window comes straight back to
  // it without the user re-picking.
  const narrow = useNarrow();
  const drawn = drawableAnLayout(layout, narrow);

  // Neither is persisted — session ids churn, so a restored selection would be
  // stale (docs/subsystems/view-persistence.md). Two states, as on the
  // Sessions board: `selectedId` is the split's one inspected report (falling
  // through to the first row, so the inspector is never blank), `expanded` is
  // the set of tiles drawn open. Opening three tiles and then switching to the
  // split should not pick one of them at random.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded(cur => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  let body: React.ReactNode;
  if (loading && !reports.length) {
    body = <div className="an-empty">Loading…</div>;
  } else if (error) {
    body = <div className="an-empty">Could not load reports.</div>;
  } else if (!reports.length) {
    body = (
      <div className="an-empty">
        No sessions logged yet. Run <code>/kaizen</code> on a session to record one.
      </div>
    );
  } else if (!shown.length) {
    body = (
      <div className="an-empty">
        No reports match the current filters.{' '}
        <button type="button" className="an-clear" onClick={() => setView(clearAnalyticsFilters(view))}>Clear filters</button>
      </div>
    );
  } else if (drawn === 'tiles') {
    body = <AnalyticsTiles reports={shown} expanded={expanded} onToggle={toggle} />;
  } else {
    body = <AnalyticsSplit reports={shown} selectedId={selectedId} onSelect={setSelectedId} />;
  }

  return (
    <div className="analytics">
      {/* Two rows, as Management's band is: the title line, then the prose.
          The title line carries state and one verb — `Review due` beside the
          title when the log has gone unswept, and ↻ — while every fact about
          the section (how much of the log is here, what it is, what to do when
          a review is due) is a sentence in the line below. A chip that both
          announced a state and spelled out the command was doing the
          description's job in the row's smallest type. */}
      <div className="an-bar">
        <div className="an-bandrow">
          <div className="an-title">Analytics</div>
          {data?.reviewDue && (
            <span
              className="an-review"
              title={
                data.lastReviewAt
                  ? `Last swept ${data.lastReviewAt} — lessons have accumulated since.`
                  : 'The log has never been swept.'
              }
            >
              <i aria-hidden="true" />Review due
            </span>
          )}
          <span className="spacer" />
          <button className="icon-refresh" onClick={refresh} title="Reload">↻</button>
        </div>
        {/* Two lines at this measure, which is what keeps it a caption rather
            than a paragraph nobody reads — so it carries only what the page
            cannot show: where the list comes from, that nothing here writes,
            and the one move to make when a review is due. The rest (why it
            does not poll, when the log was last swept) is the chip's tooltip
            and the subsystem doc. One colour throughout: the sentence that
            asks for something is not a different kind of sentence. */}
        <div className="an-sub">
          The last {data?.keep ?? 5} sessions <code>/kaizen</code> logged, each lesson beside a
          live re-run of the analyzer. Read-only — the list changes only when{' '}
          {/* the space is explicit: JSX drops a newline that follows a tag, so
              `</code>` at a line end would butt straight against the word */}
          <code>/kaizen</code> runs.
          {data?.reviewDue && <> Lessons have piled up — run <code>/kaizen review</code>.</>}
        </div>
      </div>

      {reports.length > 0 && (
        <AnalyticsToolbar
          reports={reports}
          shownCount={shown.length}
          view={view}
          onChange={setView}
          layout={drawn}
          onLayout={setLayout}
          narrow={narrow}
        />
      )}

      {body}
    </div>
  );
}
