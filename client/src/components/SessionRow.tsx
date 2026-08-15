import type { Session } from '../../../shared/types';
import { fmtTok, formatAgo } from '../lib/format';
import { SessionDetail } from './SessionDetail';
import { STATUS_LABEL } from '../lib/filterSort';

interface Props {
  s: Session;
  selected: boolean;
  onToggle: () => void;
  onOpenChat: () => void;
}

/** One dashboard row: status dot, project/branch/model, tokens+%, context bar, activity.
 *  Click to expand a subagent-activity panel; the `chat` pill opens the history drawer. */
export function SessionRow({ s, selected, onToggle, onOpenChat }: Props) {
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
          <span className="session-name">{s.sessionName}</span>
        ) : (
          <span className="proj">{s.project}</span>
        )}
        {s.sessionName && <span className="proj-pill">{s.project}</span>}
        {s.gitBranch && <span className="branch">{s.gitBranch}</span>}
        <span className="model">{s.model}</span>
        {s.kaizenLesson && (
          <span className="ag-pill kaizen" title={s.kaizenLesson}>kaizen</span>
        )}
        {/* A remote wait is held for this session. The panel that answers it lives
            in the chat drawer, so the pill is the way in — otherwise the question
            would be invisible until you happened to open that drawer. */}
        {s.remoteQuestion && (
          <button
            className="ag-pill answer"
            onClick={e => { e.stopPropagation(); onOpenChat(); }}
            title="A question is waiting on you — answer it in the chat drawer"
          >
            answer
          </button>
        )}
        {/* A plan is held for a verdict. Same route in as `answer`, different
            word because the panel offers different verbs: you can send it back
            from here, but approving only happens on the card. */}
        {s.remotePlan && !s.remoteQuestion && (
          <button
            className="ag-pill answer"
            onClick={e => { e.stopPropagation(); onOpenChat(); }}
            title="A plan is waiting — revise it from the chat drawer, or approve it in that terminal"
          >
            plan?
          </button>
        )}
        {/* A permission dialog is open in that session's terminal. Only a pointer:
            the dialog can't be answered from here, so the pill says where to go
            and the drawer banner names the command it's asking about. */}
        {s.permissionWait && !s.remoteQuestion && !s.remotePlan && (
          <button
            className="ag-pill permission"
            onClick={e => { e.stopPropagation(); onOpenChat(); }}
            title="Claude is waiting for permission — answer it in that terminal"
          >
            allow?
          </button>
        )}
        {/* the pill has no own handler: clicking it toggles the row like the rest
            of .r1, expanding the panel below where the full lesson is shown. */}
        {/* the chat pill DOES stop propagation — it opens the drawer instead of
            toggling the agents panel. */}
        <button
          className="chat-pill"
          onClick={e => { e.stopPropagation(); onOpenChat(); }}
          title="Open chat history"
        >
          chat
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
