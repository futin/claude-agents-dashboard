import { useState, type MouseEvent } from 'react';
import type { Session } from '../../../shared/types';
import { fmtTok, formatAgo } from '../lib/format';
import { SessionDetail } from './SessionDetail';

const STATUS_LABEL: Record<Session['status'], string> = {
  working: 'working',
  idle: 'idle',
  question: 'waiting',
  incomplete: 'pending'
};

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

  const [resumeErr, setResumeErr] = useState<string | null>(null);

  async function resume(e: MouseEvent) {
    e.stopPropagation(); // don't also toggle the detail panel
    setResumeErr(null);
    try {
      const res = await fetch('/api/open-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setResumeErr(e instanceof Error ? e.message : 'failed');
      setTimeout(() => setResumeErr(null), 4000);
    }
  }

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
        <span className="proj">{s.project}</span>
        {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
        <span className="model">{s.model}</span>
        <button
          className={`resume${resumeErr ? ' err' : ''}`}
          title={resumeErr ? `Couldn't open: ${resumeErr}` : 'Resume in Claude Code (iTerm)'}
          onClick={resume}
        >
          {resumeErr ? '⚠' : '↗'}
        </button>
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
      {selected && <SessionDetail id={s.id} />}
    </div>
  );
}
