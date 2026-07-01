import { useSessionDetail } from '../hooks/useSessionDetail';
import { fmtDuration, fmtTok } from '../lib/format';
import type { AgentJob } from '../../../shared/types';

/**
 * Timeline math: one shared range across all agents (earliest launch → latest
 * end, or "now" for running agents), each bar positioned by % of that span.
 * Overlapping bars = agents that ran in parallel. `now` is taken per render —
 * the 3s detail poll re-renders, so running bars grow on their own.
 */
function timeRange(agents: AgentJob[], now: number): { min: number; span: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const a of agents) {
    const start = a.startedAt ? Date.parse(a.startedAt) : NaN;
    if (!Number.isFinite(start)) continue;
    const end = a.endedAt ? Date.parse(a.endedAt) : now;
    if (start < min) min = start;
    if (end > max) max = end;
  }
  if (!Number.isFinite(min)) return null;
  return { min, span: Math.max(max - min, 1000) };
}

/** Right-aligned metrics: tokens · tool count · duration (live while running). */
function agentMeta(a: AgentJob, now: number): string {
  const parts: string[] = [];
  if (a.tokens != null) parts.push(fmtTok(a.tokens) + ' tok');
  if (a.toolUses != null) parts.push(a.toolUses + ' tools');
  if (a.status === 'done' && a.durationMs != null) {
    parts.push(fmtDuration(a.durationMs));
  } else if (a.status === 'running' && a.startedAt) {
    const start = Date.parse(a.startedAt);
    if (Number.isFinite(start)) parts.push(fmtDuration(now - start));
  }
  return parts.join(' · ');
}

/** Expanded panel under a selected row: subagent counts + per-agent rows, each
 *  with its start→finish bar on the session's shared time axis. */
export function SessionDetail({ id }: { id: string }) {
  const detail = useSessionDetail(id);

  if (!detail) {
    return <div className="detail"><div className="detail-empty">Loading agents…</div></div>;
  }
  if (detail.error) {
    return <div className="detail"><div className="detail-empty">Couldn’t read this session.</div></div>;
  }

  const now = Date.now();
  const range = timeRange(detail.agents, now);

  return (
    <div className="detail" onClick={e => e.stopPropagation()}>
      <div className="detail-sum">
        <span className="ds-run">{detail.running} running</span>
        <span>·</span>
        <span className="ds-done">{detail.finished} finished</span>
        <span className="ds-total">{detail.agents.length} agents</span>
      </div>
      {detail.agents.length === 0 ? (
        <div className="detail-empty">No agents launched this session.</div>
      ) : (
        <>
          <div className="agents">
            {detail.agents.map(a => {
              const start = a.startedAt ? Date.parse(a.startedAt) : NaN;
              let bar: { left: number; width: number } | null = null;
              if (range && Number.isFinite(start)) {
                const end = a.endedAt ? Date.parse(a.endedAt) : now;
                bar = {
                  left: ((start - range.min) / range.span) * 100,
                  width: Math.max(((end - start) / range.span) * 100, 0)
                };
              }
              return (
                <div key={a.id} className="agent-block">
                  <div className="agent">
                    <span className={`ag-pill ${a.status}`}>{a.status === 'running' ? 'running' : 'done'}</span>
                    <span className="ag-type">{a.type || 'agent'}</span>
                    <span className="ag-desc">{a.description}</span>
                    <span className="ag-dur">{agentMeta(a, now)}</span>
                  </div>
                  {bar && (
                    <div className="tl-track">
                      <div
                        className={`tl-bar${a.status === 'running' ? ' running' : ''}`}
                        style={{ left: bar.left + '%', width: bar.width + '%' }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {range && (
            <div className="tl-axis">
              <span>0s</span>
              <span>{fmtDuration(range.span)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
