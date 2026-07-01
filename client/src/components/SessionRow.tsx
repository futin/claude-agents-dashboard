import type { Session } from '../../../shared/types';
import { fmtTok, formatAgo } from '../lib/format';

const STATUS_LABEL: Record<Session['status'], string> = {
  working: 'working',
  idle: 'idle',
  question: 'waiting',
  incomplete: 'pending'
};

/** One dashboard row: status dot, project/branch/model, tokens+%, context bar, activity. */
export function SessionRow({ s }: { s: Session }) {
  const pct = s.contextPct || 0;
  const warn = pct >= 70;
  const statusTxt = STATUS_LABEL[s.status];

  return (
    <div className={`row ${s.status}`}>
      <div className="r1">
        <span className="dot" />
        <span className="proj">{s.project}</span>
        {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
        <span className="model">{s.model}</span>
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
    </div>
  );
}
