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

interface Tab {
  label: string;
  tone: '' | 'answer' | 'permission';
  title: string;
}

/** What the right-edge tab says. Every hold a session can be in routes to the
 *  same place — the chat drawer — so they share one control instead of four
 *  9px pills competing with the printed fields in `.r1`. Precedence is the
 *  order below: the nearest thing to a blocked session wins the tab. */
function chatTab(s: Session): Tab {
  if (s.remoteQuestion) {
    return { label: 'answer', tone: 'answer', title: 'A question is waiting on you — answer it in the chat drawer' };
  }
  if (s.remotePlan) {
    return { label: 'plan?', tone: 'answer', title: 'A plan is waiting — revise it from the chat drawer, or approve it in that terminal' };
  }
  if (s.remoteReply) {
    return { label: 'reply?', tone: 'answer', title: 'Turn finished — reply from the chat drawer, or let it stop' };
  }
  if (s.permissionWait) {
    return { label: 'allow?', tone: 'permission', title: 'Claude is waiting for permission — answer it in that terminal' };
  }
  return { label: 'chat', tone: '', title: 'Open chat history' };
}

/** One dashboard row: status dot, project/branch/model, tokens+%, context bar, activity.
 *  Click the card to expand a subagent-activity panel; the full-height tab down the
 *  right edge opens the history drawer — and names the hold when there is one. */
export function SessionRow({ s, selected, onToggle, onOpenChat }: Props) {
  const pct = s.contextPct || 0;
  const warn = pct >= 70;
  const statusTxt = STATUS_LABEL[s.status];
  const tab = chatTab(s);

  return (
    <div className={`row ${s.status}${selected ? ' selected' : ''}`}>
      {/* the card is its own click target; the tab is a sibling, so opening the
          drawer no longer has to out-shout a row toggle it sits inside */}
      <div className="row-main" onClick={onToggle} role="button" aria-expanded={selected}>
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
          {/* the pill has no own handler: clicking it toggles the row like the rest
              of .r1, expanding the panel below where the full lesson is shown. */}
          {s.kaizenLesson && (
            <span className="ag-pill kaizen" title={s.kaizenLesson}>kaizen</span>
          )}
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
      <button
        className={`row-chat${tab.tone ? ' ' + tab.tone : ''}`}
        onClick={onOpenChat}
        title={tab.title}
        aria-label={tab.title}
      >
        <span className="rc-in">
          <span className="rc-label">{tab.label}</span>
          <span className="rc-mark" aria-hidden="true">▸</span>
        </span>
      </button>
    </div>
  );
}
