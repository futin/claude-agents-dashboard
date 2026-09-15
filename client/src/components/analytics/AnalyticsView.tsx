import { useMemo, useState } from 'react';

import type { AnalyticsReport, LessonStatus, SessionAnalysis } from '../../../../shared/types';
import { fmtTok, fmtDuration } from '../../lib/format';
import { keyActivate } from '../sessions/atoms';
import { useAnalytics } from '../../hooks/useAnalytics';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  applyAnalyticsView,
  clearAnalyticsFilters,
  DEFAULT_ANALYTICS_VIEW,
  type AnalyticsView as AnalyticsViewState
} from '../../lib/analyticsFilterSort';
import { AnalyticsToolbar } from './AnalyticsToolbar';

/**
 * Analytics section — the last N sessions the `/kaizen` skill has logged, each
 * pairing its lesson with a live re-run of the deterministic analyzer. Read-only:
 * `/kaizen` is the sole producer (a session appears here only after `/kaizen`
 * logs it to ~/.claude/session-analytics-log.md). Default export → lazy chunk, so the
 * sessions bundle is unaffected.
 *
 * The shape is the Sessions **split** view, down to its markup: the log as a
 * `.list` of `.lrow`s on the left, one report open in the `.inspect` card
 * beside it. That is deliberate — the two sections differ in subject, not in
 * kind, so the row's dot carries what became of the lesson where Sessions
 * carries a session's state, and the figure column is billable tokens where
 * Sessions shows context used. (Four other shapes were drawn as artboards
 * first — a stack of collapsing cards, a ledger table, tiles and a
 * lesson-first digest; see `docs/guides/mockups/redesign-mock.html`.)
 */
export default function AnalyticsView() {
  const { data, loading, error, refresh } = useAnalytics();
  const reports = data?.reports ?? [];

  const [view, setView] = usePersistedState<AnalyticsViewState>(
    'dashboard.analyticsView',
    DEFAULT_ANALYTICS_VIEW
  );
  const shown = useMemo(() => applyAnalyticsView(reports, view, Date.now()), [reports, view]);

  // Which report the inspector holds. Not persisted — session ids churn, so a
  // restored selection would be stale (docs/subsystems/view-persistence.md),
  // and falling through to the first row means the inspector is never blank
  // while there is something to show. Same rule as the Sessions split.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find(r => r.sessionId === selectedId) ?? shown[0] ?? null;

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
  } else {
    body = (
      <div className="split">
        <div className="s-card list">
          <div className="list-h">
            <span className="ct">Logged sessions</span>
            <span className="proj-pill">{shown.length}</span>
          </div>
          {shown.map(r => (
            <LogRow
              key={r.sessionId}
              r={r}
              selected={selected?.sessionId === r.sessionId}
              onSelect={() => setSelectedId(r.sessionId)}
            />
          ))}
        </div>
        {selected && <Inspector r={selected} />}
      </div>
    );
  }

  return (
    <div className="analytics">
      <div className="an-bar">
        <div className="an-title">Session analytics</div>
        <span className="an-hint">last {data?.keep ?? 5} sessions logged by <code>/kaizen</code></span>
        <span className="spacer" />
        {data?.reviewDue && (
          <span
            className="an-review"
            title={
              data.lastReviewAt
                ? `Last swept ${data.lastReviewAt} — lessons have accumulated since.`
                : 'The log has never been swept.'
            }
          >
            review due — run <code>/kaizen review</code>
          </span>
        )}
        <button className="an-refresh" onClick={refresh} title="Reload">↻</button>
      </div>

      {reports.length > 0 && (
        <AnalyticsToolbar reports={reports} shownCount={shown.length} view={view} onChange={setView} />
      )}

      {body}
    </div>
  );
}

/** Eight characters is what the log line itself carries, and what identifies a run. */
const shortId = (id: string) => id.slice(0, 8);

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

/** The open report: the log line's facts, the five figures, the two ledgers, the lesson. */
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

      {a ? (
        <>
          <Metrics a={a} />
          <div className="an-cols">
            <TopTools a={a} />
            <TopAgents a={a} />
          </div>
        </>
      ) : (
        <div className="an-gone">Transcript no longer on disk — showing the logged lesson only.</div>
      )}

      <div className="an-lesson">
        {/* Management's third-column section label, verbatim — the same job in
            the same place: naming the block under the facts. */}
        <div className="mdetail-label">Research &amp; suggestions</div>
        <p className="an-lesson-body">{r.lesson}</p>
        <LessonOutcome s={r.lessonStatus} />
      </div>
    </div>
  );
}

/**
 * The five figures. The subagent count and the retry count ride in their
 * labels rather than beside their values: the strip sits in the inspector,
 * which is narrower than a full-width card, and a two-part value wraps there
 * and drops its label out of line with the other four.
 */
function Metrics({ a }: { a: SessionAnalysis }) {
  return (
    <div className="an-metrics">
      <Metric label="billable" value={fmtTok(a.totals.billableApprox)} lead />
      <Metric label="context" value={fmtTok(a.totals.combined)} />
      <Metric label={`subagents · ${a.subagentTotals.count}`} value={fmtTok(a.subagentTotals.tokens)} />
      <Metric label="turns" value={String(a.perTurn.count)} />
      <Metric
        label={`errors · ${a.errorSignals.retries} retry`}
        value={String(a.errorSignals.toolErrors)}
        warn={a.errorSignals.toolErrors > 0}
      />
    </div>
  );
}

function TopTools({ a }: { a: SessionAnalysis }) {
  const top = a.byTool.slice(0, 3);
  return (
    <div className="an-col">
      <div className="an-col-h">Top tools <span className="an-approx">approx tokens</span></div>
      {top.length ? top.map(t => (
        <div key={t.tool} className="an-line">
          <span className="an-line-name">{t.tool}</span>
          <span className="an-line-meta">
            {fmtTok(t.approxOutputTokens)} · {t.count}×{t.errors ? ` · ${t.errors} err` : ''}
          </span>
        </div>
      )) : <div className="an-line muted">none</div>}
    </div>
  );
}

function TopAgents({ a }: { a: SessionAnalysis }) {
  const top = [...a.bySubagent].sort((x, y) => (y.tokens ?? 0) - (x.tokens ?? 0)).slice(0, 3);
  return (
    <div className="an-col">
      <div className="an-col-h">Top subagents</div>
      {top.length ? top.map(g => (
        <div key={g.id} className="an-line">
          <span className="an-line-name">{g.type || 'agent'}</span>
          <span className="an-line-meta">
            {g.tokens != null ? fmtTok(g.tokens) : '—'}{g.toolUses != null ? ` · ${g.toolUses}⚒` : ''}
          </span>
        </div>
      )) : <div className="an-line muted">none launched</div>}
    </div>
  );
}

const STATUS_MARK: Record<LessonStatus['status'], string> = {
  actioned: '✓',
  promoted: '↑',
  dropped: '·'
};

/**
 * What became of this session's lesson as the row's lead dot — the place the
 * Sessions split states a session's status. Open is the quiet one: it is the
 * default, and a loud default would make every fresh entry shout.
 */
function LessonDot({ s }: { s?: LessonStatus | null }) {
  return <span className={`an-dot ${s ? s.status : 'open'}`} aria-hidden="true" />;
}

/**
 * The same fact spelled out, from the log's `status` lines. A lesson with no
 * status line is still open — shown as such, since "which lessons have I
 * actually acted on" is the question the badge exists to answer.
 */
function StatusBadge({ s }: { s?: LessonStatus | null }) {
  if (!s) return <span className="an-status open" title="No status line yet — still open.">○ open</span>;
  return (
    <span className={`an-status ${s.status}`} title={`${s.note ? `${s.note} — ` : ''}${s.date}`}>
      {STATUS_MARK[s.status]} {s.status}
    </span>
  );
}

/** The status line's note, spelled out under the lesson. */
function LessonOutcome({ s }: { s?: LessonStatus | null }) {
  if (!s) return null;
  return (
    <p className="an-lesson-body muted">
      {s.status} {s.date}{s.note ? ` — ${s.note}` : ''}
    </p>
  );
}

function Metric({ label, value, lead, warn }: { label: string; value: string; lead?: boolean; warn?: boolean }) {
  return (
    <div className={`an-metric${lead ? ' lead' : ''}`}>
      <div className={`an-metric-v${warn ? ' warn' : ''}`}>{value}</div>
      <div className="an-metric-l">{label}</div>
    </div>
  );
}
