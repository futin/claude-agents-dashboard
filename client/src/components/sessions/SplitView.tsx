import type { LaunchingSession, Session } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { Act, ActLine, Bar, ChatButton, Dot, LaunchPill, Pct, StatusPill, Tags, Tok, keyActivate, launchState } from './atoms';
import { Expanded } from './Expanded';

/**
 * A compact list and one inspector. Selection is the list's, not the shared
 * expanded set: exactly one session is open here, and it is whichever row
 * was clicked last — or the first row, so the inspector is never blank while
 * there is something to show.
 */
export function SplitView({ sessions, launching, selectedId, onSelect, onOpenChat }: {
  sessions: Session[];
  launching: LaunchingSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenChat: (id: string) => void;
}) {
  const selected = sessions.find(s => s.id === selectedId) ?? sessions[0] ?? null;
  return (
    <div className="split">
      <div className="s-card list">
        <div className="list-h">
          <span className="ct">Sessions</span>
          <span className="proj-pill">{sessions.length + launching.length}</span>
        </div>
        {launching.map(p => <LaunchRow key={p.sessionId} entry={p} />)}
        {sessions.map(s => (
          <div
            key={s.id}
            className={`lrow ${s.status}${selected?.id === s.id ? ' selected' : ''}`}
            onClick={() => onSelect(s.id)}
            onKeyDown={keyActivate(() => onSelect(s.id))}
            tabIndex={0}
            role="button"
            aria-pressed={selected?.id === s.id}
          >
            <Dot status={s.status} />
            <span className="nm">
              <span className="t">{s.sessionName || s.project}</span>
              {s.sessionName && <span className="proj-pill">{s.project}</span>}
            </span>
            <Pct s={s} />
            <ActLine s={s} />
            <Bar s={s} />
          </div>
        ))}
      </div>
      {selected ? (
        <Inspector s={selected} onOpenChat={() => onOpenChat(selected.id)} />
      ) : (
        <div className="s-card inspect"><div className="cs">Pick a session on the left.</div></div>
      )}
    </div>
  );
}

function Inspector({ s, onOpenChat }: { s: Session; onOpenChat: () => void }) {
  return (
    <div className="s-card inspect">
      <div className="ins-head">
        <div className="who2">
          <div className="ct">{s.sessionName || s.project}</div>
          <div className="ins-meta"><Dot status={s.status} /><StatusPill s={s} /><Tags s={s} withTitle={false} /></div>
        </div>
        <ChatButton s={s} onOpenChat={onOpenChat} />
      </div>
      <div className="ins-ctx">
        <div className="kv">
          <div className="k">Context</div>
          <div className="v"><Pct s={s} big /><span className="u"><Tok s={s} /></span></div>
          <Bar s={s} track />
        </div>
        <div className="kv">
          <div className="k">Now · {formatAgo(s.updatedMs)} ago</div>
          <div className="now"><Act s={s} /></div>
          {s.version && <div className="cap">Claude Code {s.version}</div>}
        </div>
      </div>
      <Expanded s={s} />
    </div>
  );
}

function LaunchRow({ entry }: { entry: LaunchingSession }) {
  const { text, failed } = launchState(entry);
  return (
    <div className={`lrow launching${failed ? ' failed' : ''}`}>
      <Dot status={failed ? 'failed' : 'launching'} />
      <span className="nm"><span className="t">{entry.projectName}</span><LaunchPill entry={entry} /></span>
      <span />
      <span className="prompt" title={text}>{text}</span>
    </div>
  );
}
