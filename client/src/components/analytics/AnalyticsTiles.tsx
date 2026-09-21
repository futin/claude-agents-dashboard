import type { AnalyticsReport } from '../../../../shared/types';
import { fmtTok } from '../../lib/format';
import { keyActivate } from '../sessions/atoms';
import { LessonDot, ReportBody, StatusBadge, shortId } from './atoms';

/**
 * Every report a metric card, the billable total as its figure — the Sessions
 * tiles grid with cost where a session shows the context percentage. Cards are
 * collapsed by default and open in place, spanning two columns (`.tile.selected`)
 * to make room for the figures and the two ledgers.
 *
 * Expansion, not selection: the split holds exactly one report open and falls
 * through to the first row, which is right for a master/detail pane and wrong
 * here — a grid whose first cell is always open reads as a mistake. Any number
 * of tiles can be open, and a fresh grid has none, so the shape opens on the
 * one thing a grid is for: comparing the figures side by side.
 */
export function AnalyticsTiles({ reports, expanded, onToggle }: {
  reports: AnalyticsReport[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="tiles">
      {reports.map(r => (
        <ReportTile
          key={r.sessionId}
          r={r}
          open={expanded.has(r.sessionId)}
          onToggle={() => onToggle(r.sessionId)}
        />
      ))}
    </div>
  );
}

function ReportTile({ r, open, onToggle }: { r: AnalyticsReport; open: boolean; onToggle: () => void }) {
  const a = r.analysis;
  return (
    <div
      className={`s-card sm tile${open ? ' selected' : ''}`}
      onClick={onToggle}
      onKeyDown={keyActivate(onToggle)}
      tabIndex={0}
      role="button"
      aria-expanded={open}
    >
      <div className="tile-h">
        <LessonDot s={r.lessonStatus} />
        <span className="nm">{r.project}</span>
        <StatusBadge s={r.lessonStatus} />
      </div>
      <div className="tile-sub">
        {r.models.map(m => <span key={m} className="model">{m}</span>)}
        <span className="an-id">{a ? shortId(r.sessionId) : 'transcript gone'}</span>
        <span className="an-when">{r.loggedAt}</span>
      </div>
      {/* Collapsed, the tile is its figure and its lesson: the billable total
          with the context beside it, then the lesson clamped — the one thing
          on the card that is not a number, and the reason the session was
          logged. Both go when the tile opens: the strip below leads with that
          same billable figure in the same green and carries context as its
          second cell, and the lesson is spelled out in full under its own
          label. The same fact twice on one card reads as a bug. */}
      {!open && (
        <>
          <div className="tile-metric">
            <span className="metric">{a ? fmtTok(a.totals.billableApprox) : '—'}</span>
            <span className="of">
              billable{a ? ` · ${fmtTok(a.totals.combined)} context` : ''}
            </span>
          </div>
          <p className="an-tile-lesson">{r.lesson}</p>
        </>
      )}
      {open && <ReportBody r={r} />}
    </div>
  );
}
