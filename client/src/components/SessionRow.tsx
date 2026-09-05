import { useState } from 'react';

import type { Session } from '../../../shared/types';
import { fmtTok, formatAgo } from '../lib/format';
import { SessionDetail } from './SessionDetail';
import { STATUS_LABEL } from '../lib/filterSort';
import { holdKind, type HoldKind } from '../lib/holds';
import { stopControl } from '../lib/stopControl';
import { surfacePill } from '../lib/surface';
import { useStopSession } from '../hooks/useStopSession';

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

const HOLD_TABS: Record<HoldKind, Tab> = {
  question: { label: 'answer', tone: 'answer', title: 'A question is waiting on you — answer it in the chat drawer' },
  plan: { label: 'plan?', tone: 'answer', title: 'A plan is waiting — revise it from the chat drawer, or approve it in that terminal' },
  reply: { label: 'reply?', tone: 'answer', title: 'Turn finished — reply from the chat drawer, or let it stop' },
  permission: { label: 'allow?', tone: 'permission', title: 'Claude is waiting for permission — answer it in that terminal' }
};

const NO_HOLD_TAB: Tab = { label: 'chat', tone: '', title: 'Open chat history' };

/** What the right-edge tab says. Every hold a session can be in routes to the
 *  same place — the chat drawer — so they share one control instead of four
 *  9px pills competing with the printed fields in `.r1`. Precedence — the
 *  nearest thing to a blocked session wins the tab — is `holdKind`'s, shared
 *  with the header count and the browser notifications. */
function chatTab(s: Session): Tab {
  const kind = holdKind(s);
  return kind ? HOLD_TABS[kind] : NO_HOLD_TAB;
}

/** One dashboard row: status dot, project/branch/model, tokens+%, context bar, activity.
 *  Click the card to expand a subagent-activity panel; the full-height tab down the
 *  right edge opens the history drawer — and names the hold when there is one. */
export function SessionRow({ s, selected, onToggle, onOpenChat }: Props) {
  const pct = s.contextPct || 0;
  const warn = pct >= 70;
  const statusTxt = STATUS_LABEL[s.status];
  const tab = chatTab(s);
  const surface = surfacePill(s.surface);
  const [confirming, setConfirming] = useState(false);
  const { stop, pending, error, needsToken } = useStopSession();
  const ctl = stopControl(s.stopState, confirming);

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
          {/* where the session lives, when that isn't the obvious answer — a
              headless spawn appears in no other list, which is worth saying on
              the row rather than leaving to be rediscovered. Same no-handler
              rule as the kaizen pill below. */}
          {surface && (
            <span className={`ag-pill surface ${s.surface}`} title={surface.title}>{surface.label}</span>
          )}
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
          {ctl.render && ctl.badge && <span className="stop-badge">{ctl.badge}</span>}
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
            {ctl.render && (
              /* stopPropagation, not a sibling like the chat tab: this control
                 sits inside `.row-main`, whose own onClick would otherwise
                 collapse the row out from under the confirm step it just armed. */
              <div className="stop-ctl" onClick={e => e.stopPropagation()}>
                <button
                  className="stop-go"
                  disabled={pending}
                  onClick={() => {
                    if (ctl.arms) return setConfirming(true);
                    setConfirming(false);
                    void stop(s.id, ctl.force);
                  }}
                >
                  {ctl.label}
                </button>
                {ctl.cancel && (
                  <button className="stop-cancel" onClick={() => setConfirming(false)}>cancel</button>
                )}
                {needsToken && <span className="stop-msg">Needs the dashboard token — set it in Settings.</span>}
                {!needsToken && error && <span className="stop-msg">{error}</span>}
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
