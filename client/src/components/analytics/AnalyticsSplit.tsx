import type { AnalyticsReport } from '../../../../shared/types';
import { fmtTok, fmtDuration } from '../../lib/format';
import { keyActivate } from '../sessions/atoms';
import { LessonDot, ReportBody, StatusBadge, shortId } from './atoms';

/**
 * The log as the Sessions **split**, down to its markup: a `.list` of `.lrow`s
 * on the left, one report open in the `.inspect` card beside it. That is
 * deliberate — the two sections differ in subject, not in kind, so the row's
 * dot carries what became of the lesson where Sessions carries a session's
 * state, and the figure column is billable tokens where Sessions shows context
 * used.
 *
 * Selection replaces expansion here: exactly one report is open, and it falls
 * through to the first row, so the inspector is never blank while there is
 * something to show. Same rule as the Sessions split.
 */
export function AnalyticsSplit({ reports, selectedId, onSelect }: {
  reports: AnalyticsReport[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = reports.find(r => r.sessionId === selectedId) ?? reports[0] ?? null;
  return (
    <div className="split">
      <div className="s-card list">
        <div className="list-h">
          <span className="ct">Logged sessions</span>
          <span className="proj-pill">{reports.length}</span>
        </div>
        {reports.map(r => (
          <LogRow
            key={r.sessionId}
            r={r}
            selected={selected?.sessionId === r.sessionId}
            onSelect={() => onSelect(r.sessionId)}
          />
        ))}
      </div>
      {selected && <Inspector r={selected} />}
    </div>
  );
}

/**
 * One row of the log. Mirrors the Sessions split's row exactly — dot, name,
 * figure, then a second line spanning the last two columns — so the two lists
 * are the same object with a different subject.
 */
function LogRow({ r, selected, onSelect }: { r: AnalyticsReport; selected: boolean; onSelect: () => void }) {
  const a = r.analysis;
  return (
    <div
      className={`lrow${selected ? ' selected' : ''}`}
      onClick={onSelect}
      onKeyDown={keyActivate(onSelect)}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
    >
      <LessonDot s={r.lessonStatus} />
      {/* project only, as the Sessions row carries name + project and no more:
          the models are a filter facet and belong in the inspector, where a
          long model id does not eat the name */}
      <span className="nm"><span className="t">{r.project}</span></span>
      <span className="pct">{a ? fmtTok(a.totals.billableApprox) : '—'}</span>
      <span className="act-line">
        <StatusBadge s={r.lessonStatus} />
        {/* One fact, because the column's measure only ever shows one before
            ellipsising: the id, or — when there is no analysis to open — why
            the figure beside it is a dash. Both are spelled out again in the
            inspector's meta line. */}
        <span className="act">{a ? shortId(r.sessionId) : 'transcript gone'}</span>
        <span className="ago">{r.loggedAt}</span>
      </span>
    </div>
  );
}

/** The open report: the log line's facts, then the shared body. */
function Inspector({ r }: { r: AnalyticsReport }) {
  const a = r.analysis;
  return (
    <div className="s-card inspect">
      <div className="ins-head">
        <div className="who2">
          <div className="ct">{r.project}</div>
          <div className="ins-meta">
            <LessonDot s={r.lessonStatus} />
            <StatusBadge s={r.lessonStatus} />
            {r.models.map(m => <span key={m} className="model">{m}</span>)}
            <span className="an-id">{shortId(r.sessionId)}</span>
            <span className="an-when">
              logged {r.loggedAt}{a?.durationMs != null ? ` · ${fmtDuration(a.durationMs)}` : ''}
            </span>
          </div>
        </div>
      </div>
      <ReportBody r={r} />
    </div>
  );
}
