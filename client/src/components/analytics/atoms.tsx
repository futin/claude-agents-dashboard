import type { AnalyticsReport, LessonStatus, SessionAnalysis } from '../../../../shared/types';
import { fmtTok } from '../../lib/format';

/**
 * The pieces both Analytics shapes draw — the lesson's fate in its three
 * forms, the five figures, the two ledgers, and the lesson itself. They live
 * here rather than in `AnalyticsView` because the split's inspector and the
 * open tile show the same report; the shapes differ in what leads, not in what
 * a report is. Mirrors `sessions/atoms.tsx`.
 */

/** Eight characters is what the log line itself carries, and what identifies a run. */
export const shortId = (id: string) => id.slice(0, 8);

const STATUS_MARK: Record<LessonStatus['status'], string> = {
  actioned: '✓',
  promoted: '↑',
  dropped: '·'
};

/**
 * What became of this session's lesson, as the lead dot — the place the
 * Sessions split states a session's status. Open is the quiet one: it is the
 * default, and a loud default would make every fresh entry shout.
 */
export function LessonDot({ s }: { s?: LessonStatus | null }) {
  return <span className={`an-dot ${s ? s.status : 'open'}`} aria-hidden="true" />;
}

/**
 * The same fact spelled out, from the log's `status` lines. A lesson with no
 * status line is still open — shown as such, since "which lessons have I
 * actually acted on" is the question the badge exists to answer.
 */
export function StatusBadge({ s }: { s?: LessonStatus | null }) {
  if (!s) return <span className="an-status open" title="No status line yet — still open.">○ open</span>;
  return (
    <span className={`an-status ${s.status}`} title={`${s.note ? `${s.note} — ` : ''}${s.date}`}>
      {STATUS_MARK[s.status]} {s.status}
    </span>
  );
}

/** The status line's note, spelled out under the lesson. */
export function LessonOutcome({ s }: { s?: LessonStatus | null }) {
  if (!s) return null;
  return (
    <p className="an-lesson-body muted">
      {s.status} {s.date}{s.note ? ` — ${s.note}` : ''}
    </p>
  );
}

/**
 * The numbers and the lesson — everything under a report's own heading, and
 * the whole of what the two shapes share. The split draws it under the
 * inspector's head; a tile draws it when opened, under the figure it leads
 * with.
 */
export function ReportBody({ r }: { r: AnalyticsReport }) {
  const a = r.analysis;
  return (
    <>
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
    </>
  );
}

/**
 * The five figures. The subagent count and the retry count ride in their
 * labels rather than beside their values: the strip sits in the inspector,
 * which is narrower than a full-width card, and a two-part value wraps there
 * and drops its label out of line with the other four.
 */
export function Metrics({ a }: { a: SessionAnalysis }) {
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

export function TopTools({ a }: { a: SessionAnalysis }) {
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

export function TopAgents({ a }: { a: SessionAnalysis }) {
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

export function Metric({ label, value, lead, warn }: { label: string; value: string; lead?: boolean; warn?: boolean }) {
  return (
    <div className={`an-metric${lead ? ' lead' : ''}`}>
      <div className={`an-metric-v${warn ? ' warn' : ''}`}>{value}</div>
      <div className="an-metric-l">{label}</div>
    </div>
  );
}
