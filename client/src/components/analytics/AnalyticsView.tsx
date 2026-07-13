import { useMemo, useState } from 'react';

import type { AnalyticsReport } from '../../../../shared/types';
import { fmtTok, fmtDuration } from '../../lib/format';
import { useAnalytics } from '../../hooks/useAnalytics';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  applyAnalyticsView,
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
 * Mirrors the Sessions view: a filter/sort Toolbar (persisted) and cards that are
 * collapsed by default, expanding on click.
 */
export default function AnalyticsView() {
  const { data, loading, error, refresh } = useAnalytics();
  const reports = data?.reports ?? [];

  const [view, setView] = usePersistedState<AnalyticsViewState>(
    'dashboard.analyticsView',
    DEFAULT_ANALYTICS_VIEW
  );
  const shown = useMemo(() => applyAnalyticsView(reports, view, Date.now()), [reports, view]);

  // Which cards are expanded. Ephemeral — not persisted (matches Sessions row-expansion).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpandedIds(cur => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="analytics">
      <div className="an-bar">
        <div className="an-title">Session analytics</div>
        <span className="an-hint">last {data?.keep ?? 5} sessions logged by <code>/kaizen</code></span>
        <span className="spacer" />
        <button className="an-refresh" onClick={refresh} title="Reload">↻</button>
      </div>

      {reports.length > 0 && (
        <AnalyticsToolbar reports={reports} view={view} onChange={setView} />
      )}

      {loading && !reports.length ? (
        <div className="an-empty">Loading…</div>
      ) : error ? (
        <div className="an-empty">Could not load reports.</div>
      ) : !reports.length ? (
        <div className="an-empty">
          No sessions logged yet. Run <code>/kaizen</code> on a session to record one.
        </div>
      ) : !shown.length ? (
        <div className="an-empty">No reports match the current filters.</div>
      ) : (
        <div className="an-list">
          {shown.map(r => (
            <ReportCard
              key={r.sessionId}
              r={r}
              selected={expandedIds.has(r.sessionId)}
              onToggle={() => toggle(r.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({
  r,
  selected,
  onToggle
}: {
  r: AnalyticsReport;
  selected: boolean;
  onToggle: () => void;
}) {
  const a = r.analysis;
  const topTools = a ? a.byTool.slice(0, 3) : [];
  const topAgents = a
    ? [...a.bySubagent].sort((x, y) => (y.tokens ?? 0) - (x.tokens ?? 0)).slice(0, 3)
    : [];

  return (
    <div className={`an-card${selected ? ' selected' : ''}`}>
      <div
        className="an-head"
        onClick={onToggle}
        role="button"
        aria-expanded={selected}
      >
        <span className={`caret${selected ? ' open' : ''}`} aria-hidden="true">▸</span>
        <span className="an-proj">{r.project}</span>
        {r.models.map(m => <span key={m} className="an-model">{m}</span>)}
        <span className="an-id">{r.sessionId.slice(0, 8)}</span>
        <span className="spacer" />
        {a && <span className="an-tok">{fmtTok(a.totals.billableApprox)}</span>}
        <span className="an-when">logged {r.loggedAt}</span>
        {a?.durationMs != null && <span className="an-when">· {fmtDuration(a.durationMs)}</span>}
      </div>

      {selected && (
        a ? (
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

            <div className="an-lesson">
              <div className="an-col-h">Research &amp; suggestions</div>
              <p className="an-lesson-body">{r.lesson}</p>
            </div>
          </>
        ) : (
          <>
            <div className="an-line muted">Transcript no longer on disk — showing the logged lesson only.</div>
            <div className="an-lesson">
              <div className="an-col-h">Research &amp; suggestions</div>
              <p className="an-lesson-body">{r.lesson}</p>
            </div>
          </>
        )
      )}
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
