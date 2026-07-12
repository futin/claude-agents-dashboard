import type { AnalyticsReport } from '../../../../shared/types';
import { fmtTok, fmtDuration } from '../../lib/format';
import { useAnalytics } from '../../hooks/useAnalytics';

/**
 * Analytics section — the last N sessions the `/kaizen` skill has logged, each
 * pairing its lesson with a live re-run of the deterministic analyzer. Read-only:
 * `/kaizen` is the sole producer (a session appears here only after `/kaizen`
 * logs it to ~/.claude/session-analytics-log.md). Default export → lazy chunk, so the
 * sessions bundle is unaffected.
 */
export default function AnalyticsView() {
  const { data, loading, error, refresh } = useAnalytics();
  const reports = data?.reports ?? [];

  return (
    <div className="analytics">
      <div className="an-bar">
        <div className="an-title">Session analytics</div>
        <span className="an-hint">last {data?.keep ?? 5} sessions logged by <code>/kaizen</code></span>
        <span className="spacer" />
        <button className="an-refresh" onClick={refresh} title="Reload">↻</button>
      </div>

      {loading && !reports.length ? (
        <div className="an-empty">Loading…</div>
      ) : error ? (
        <div className="an-empty">Could not load reports.</div>
      ) : !reports.length ? (
        <div className="an-empty">
          No sessions logged yet. Run <code>/kaizen</code> on a session to record one.
        </div>
      ) : (
        <div className="an-list">
          {reports.map(r => <ReportCard key={r.sessionId} r={r} />)}
        </div>
      )}
    </div>
  );
}

function ReportCard({ r }: { r: AnalyticsReport }) {
  const a = r.analysis;
  const topTools = a ? a.byTool.slice(0, 3) : [];
  const topAgents = a
    ? [...a.bySubagent].sort((x, y) => (y.tokens ?? 0) - (x.tokens ?? 0)).slice(0, 3)
    : [];

  return (
    <div className="an-card">
      <div className="an-head">
        <span className="an-proj">{r.project}</span>
        {r.models.map(m => <span key={m} className="an-model">{m}</span>)}
        <span className="an-id">{r.sessionId.slice(0, 8)}</span>
        <span className="spacer" />
        <span className="an-when">logged {r.loggedAt}</span>
        {a?.durationMs != null && <span className="an-when">· {fmtDuration(a.durationMs)}</span>}
      </div>

      {a ? (
        <>
          <div className="an-metrics">
            <Metric label="billable" value={fmtTok(a.totals.billableApprox)} lead />
            <Metric label="context" value={fmtTok(a.totals.combined)} />
            <Metric label="subagents" value={`${a.subagentTotals.count} · ${fmtTok(a.subagentTotals.tokens)}`} />
            <Metric label="turns" value={String(a.perTurn.count)} />
            <Metric
              label="errors"
              value={`${a.errorSignals.toolErrors} · ${a.errorSignals.retries} retry`}
              warn={a.errorSignals.toolErrors > 0}
            />
          </div>

          <div className="an-cols">
            <div className="an-col">
              <div className="an-col-h">Top tools <span className="an-approx">approx tokens</span></div>
              {topTools.length ? topTools.map(t => (
                <div key={t.tool} className="an-line">
                  <span className="an-line-name">{t.tool}</span>
                  <span className="an-line-meta">
                    {fmtTok(t.approxOutputTokens)} · {t.count}×{t.errors ? ` · ${t.errors} err` : ''}
                  </span>
                </div>
              )) : <div className="an-line muted">none</div>}
            </div>
            <div className="an-col">
              <div className="an-col-h">Top subagents</div>
              {topAgents.length ? topAgents.map(g => (
                <div key={g.id} className="an-line">
                  <span className="an-line-name">{g.type || 'agent'}</span>
                  <span className="an-line-meta">
                    {g.tokens != null ? fmtTok(g.tokens) : '—'}{g.toolUses != null ? ` · ${g.toolUses}⚒` : ''}
                  </span>
                </div>
              )) : <div className="an-line muted">none launched</div>}
            </div>
          </div>
        </>
      ) : (
        <div className="an-line muted">Transcript no longer on disk — showing the logged lesson only.</div>
      )}

      <div className="an-lesson">
        <div className="an-col-h">Research &amp; suggestions</div>
        <p className="an-lesson-body">{r.lesson}</p>
      </div>
    </div>
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
