import type { LaunchingSession, Session } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { chatTab } from '../../lib/holds';
import { triageGroups } from '../../lib/triage';
import { Act, ActLine, Bar, ChatButton, Dot, LaunchPill, Pct, Tags, Tok, launchState } from './atoms';

/**
 * What needs you, first and large; then what is working; then what is idle.
 * Nothing expands here — the hero cards carry the hold and one action, and the
 * two lists below are for scanning, not opening.
 */
export function TriageView({ sessions, launching, onOpenChat }: {
  sessions: Session[];
  launching: LaunchingSession[];
  onOpenChat: (id: string) => void;
}) {
  const g = triageGroups(sessions);
  return (
    <>
      <div className="sec-h">
        <span className="ct">Needs you</span>
        <span className="cs">{g.needs.length === 0 ? 'nothing is waiting on this desk' : `${g.needs.length} blocked on this desk`}</span>
      </div>
      {g.needs.map(s => <Need key={s.id} s={s} onOpenChat={() => onOpenChat(s.id)} />)}

      <div className="sec-h">
        <span className="ct">Working</span>
        <span className="cs">{g.working.length + launching.length} running, none blocked</span>
      </div>
      {(g.working.length > 0 || launching.length > 0) && (
        <div className="s-card quiet">
          {launching.map(p => <LaunchRow key={p.sessionId} entry={p} />)}
          {g.working.map(s => <QRow key={s.id} s={s} onOpenChat={() => onOpenChat(s.id)} />)}
        </div>
      )}

      <div className="sec-h">
        <span className="ct">Idle</span>
        <span className="cs">idle or pending — nothing to watch right now</span>
      </div>
      {g.quiet.length > 0 && (
        <div className="s-card quiet">
          {g.quiet.map(s => <QRow key={s.id} s={s} onOpenChat={() => onOpenChat(s.id)} />)}
        </div>
      )}
    </>
  );
}

/**
 * One hero card per hold. The primary action is the same drawer every hold
 * routes to; the question text itself lives in that drawer (the pending store,
 * not the row), so the card shows the tool call that raised it.
 */
function Need({ s, onOpenChat }: { s: Session; onOpenChat: () => void }) {
  const tab = chatTab(s);
  const primary = tab.tone ? tab.label.replace(/\?$/, '') : 'open chat';
  return (
    <div className={`s-card need ${tab.tone || 'answer'}`}>
      <div>
        <div className="need-who">
          <Dot status={s.status} />
          <b>{s.sessionName || s.project}</b>
          <Tags s={s} withTitle={false} />
          <span aria-hidden="true">·</span>
          <span><Tok s={s} /> · <Pct s={s} /></span>
          <span aria-hidden="true">·</span>
          <span>{formatAgo(s.updatedMs)} ago</span>
        </div>
        <div className="q">
          <span className="kind">{tab.title}</span>
          <Act s={s} />
        </div>
      </div>
      <div className="acts">
        <button type="button" className="act-go" onClick={onOpenChat}>{primary}</button>
      </div>
    </div>
  );
}

function QRow({ s, onOpenChat }: { s: Session; onOpenChat: () => void }) {
  return (
    <div className={`qrow ${s.status}`}>
      <Dot status={s.status} />
      <span className="nm">{s.sessionName || s.project}</span>
      {s.sessionName ? <span className="proj-pill">{s.project}</span> : s.gitBranch && <span className="branch" title={s.gitBranch}>{s.gitBranch}</span>}
      <ActLine s={s} ago={false} />
      <span className="ctx"><Bar s={s} /><Pct s={s} /></span>
      <span className="when">{formatAgo(s.updatedMs)} ago</span>
      <ChatButton s={s} onOpenChat={onOpenChat} />
    </div>
  );
}

function LaunchRow({ entry }: { entry: LaunchingSession }) {
  const { text, failed } = launchState(entry);
  return (
    <div className={`qrow launching${failed ? ' failed' : ''}`}>
      <Dot status={failed ? 'failed' : 'launching'} />
      <span className="nm">{entry.projectName}</span>
      <LaunchPill entry={entry} />
      <span className="prompt" title={text}>{text}</span>
    </div>
  );
}
