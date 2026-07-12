import type { Session } from '../../../shared/types';
import { fmtTok, formatAgo } from '../lib/format';
import { SessionDetail } from './SessionDetail';
import { STATUS_LABEL } from '../lib/filterSort';

interface Props {
  s: Session;
  selected: boolean;
  onToggle: () => void;
}

/** One dashboard row: status dot, project/branch/model, tokens+%, context bar, activity.
 *  Click to expand a subagent-activity panel. */
export function SessionRow({ s, selected, onToggle }: Props) {
  const pct = s.contextPct || 0;
  const warn = pct >= 70;
  const statusTxt = STATUS_LABEL[s.status];

  return (
    <div
      className={`row ${s.status}${selected ? ' selected' : ''}`}
      onClick={onToggle}
      role="button"
      aria-expanded={selected}
    >
      <div className="r1">
        <span className={`caret${selected ? ' open' : ''}`} aria-hidden="true">▸</span>
        <span className="dot" />
        {s.sessionName ? (
          <>
            <span className="session-name">{s.sessionName}</span>
            <span className="proj secondary">{s.project}</span>
          </>
        ) : (
          <span className="proj">{s.project}</span>
        )}
        {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
        <span className="model">{s.model}</span>
        {s.kaizenLesson && (
          <span className="ag-pill kaizen" title={s.kaizenLesson}>kaizen</span>
        )}
        {/* the pill has no own handler: clicking it toggles the row like the rest
            of .r1, expanding the panel below where the full lesson is shown. */}
        <span className="spacer" />
        <span className="tok">{fmtTok(s.tokens)} / {s.contextWindowLabel}</span>
        <span className="pct" style={{ color: warn ? 'var(--orange)' : 'var(--text)' }}>{pct}%</span>
      </div>
      <div className="bar">
        <div className={`fill${warn ? ' warn' : ''}`} style={{ width: Math.min(100, pct) + '%' }} />
      </div>
      <div className="r2">
        <span className="status">{statusTxt}</span>
        <span>·</span>
        <span className="act">
          {s.activity ? (
            <>
              <span className={`tool${s.activity.tool === 'Task' ? ' task' : ''}`}>{s.activity.tool}</span>
              {s.activity.detail ? ' ' + s.activity.detail : ''}
            </>
          ) : (
            <span style={{ color: 'var(--text3)' }}>no tool activity</span>
          )}
        </span>
        <span className="ago">{formatAgo(s.updatedMs)} ago</span>
      </div>
      {selected && (
        <>
          {s.kaizenLesson && (
            <div className="kaizen-lesson">
              <span className="ag-pill kaizen">kaizen</span>
              <span>{s.kaizenLesson}</span>
            </div>
          )}
          <SessionDetail id={s.id} />
        </>
      )}
    </div>
  );
}
