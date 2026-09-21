import type { LaunchingSession, Session } from '../../../../shared/types';
import { triageGroups } from '../../lib/triage';
import { ActLine, Bar, ChatButton, Dot, LaunchPill, Pct, Tags, Title, Tok, keyActivate, launchState } from './atoms';
import { Expanded } from './Expanded';
import type { ViewProps } from './views';

/**
 * Three columns by what the session wants from you: Needs you · Working ·
 * Quiet. A phantom launch sits at the head of Working — it is about to be one.
 */
export function BoardView({ sessions, launching, expanded, onToggle, onOpenChat }: ViewProps) {
  const g = triageGroups(sessions);
  const cols: { key: string; label: string; items: Session[]; phantoms?: LaunchingSession[] }[] = [
    { key: 'ask', label: 'Needs you', items: g.needs },
    { key: 'run', label: 'Working', items: g.working, phantoms: launching },
    { key: 'quiet', label: 'Quiet', items: g.quiet }
  ];
  return (
    <div className="board">
      {cols.map(c => (
        <div key={c.key} className="bcol">
          <div className={`col-h ${c.key}`}>
            {c.label}<span className="n">{c.items.length + (c.phantoms?.length ?? 0)}</span>
          </div>
          {c.phantoms?.map(p => <LaunchCard key={p.sessionId} entry={p} />)}
          {c.items.map(s => (
            <Card key={s.id} s={s} open={expanded.has(s.id)} onToggle={() => onToggle(s.id)} onOpenChat={() => onOpenChat(s.id)} />
          ))}
          {c.items.length + (c.phantoms?.length ?? 0) === 0 && <div className="bempty" aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

function Card({ s, open, onToggle, onOpenChat }: { s: Session; open: boolean; onToggle: () => void; onOpenChat: () => void }) {
  return (
    <div className={`bcard ${s.status}${open ? ' selected' : ''}`}>
      <div className="bmain" onClick={onToggle} onKeyDown={keyActivate(onToggle)} tabIndex={0} role="button" aria-expanded={open}>
        <div className="r1"><span className="r1-lead"><Dot status={s.status} /><Title s={s} /></span><Tags s={s} withTitle={false} /></div>
        <Bar s={s} />
        <div className="bmeta"><Tok s={s} /><Pct s={s} /></div>
        <ActLine s={s} />
      </div>
      {open && <Expanded s={s} />}
      <div className="bfoot"><ChatButton s={s} onOpenChat={onOpenChat} wide /></div>
    </div>
  );
}

function LaunchCard({ entry }: { entry: LaunchingSession }) {
  const { text, failed } = launchState(entry);
  return (
    <div className={`bcard launching${failed ? ' failed' : ''}`}>
      <div className="r1"><span className="r1-lead"><Dot status={failed ? 'failed' : 'launching'} /><span className="sname">{entry.projectName}</span></span></div>
      <div className="act-line"><LaunchPill entry={entry} /><span className="act" title={text}>{text}</span></div>
    </div>
  );
}
