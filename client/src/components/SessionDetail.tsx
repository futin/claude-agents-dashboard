import { useSessionDetail } from '../hooks/useSessionDetail';
import { fmtDuration } from '../lib/format';

/** Expanded panel under a selected row: subagent counts + per-agent list. */
export function SessionDetail({ id }: { id: string }) {
  const detail = useSessionDetail(id);

  if (!detail) {
    return <div className="detail"><div className="detail-empty">Loading agents…</div></div>;
  }
  if (detail.error) {
    return <div className="detail"><div className="detail-empty">Couldn’t read this session.</div></div>;
  }

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
        <div className="agents">
          {detail.agents.map(a => (
            <div key={a.id} className="agent">
              <span className={`ag-pill ${a.status}`}>{a.status === 'running' ? 'running' : 'done'}</span>
              <span className="ag-type">{a.type || 'agent'}</span>
              <span className="ag-desc">{a.description}</span>
              <span className="ag-dur">
                {a.status === 'done' && a.durationMs != null ? fmtDuration(a.durationMs) : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
