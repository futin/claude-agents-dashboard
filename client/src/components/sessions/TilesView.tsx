import type { LaunchingSession, Session } from '../../../../shared/types';
import { fmtTok } from '../../lib/format';
import { ActLine, Bar, ChatButton, Dot, LaunchPill, Pct, Tags, keyActivate, launchState } from './atoms';
import { Expanded } from './Expanded';
import type { ViewProps } from './views';

/**
 * Every session a metric card, the context percentage as its figure (DESIGN.md
 * §7). The open tile spans two columns; a phantom launch is a dashed
 * drop-target tile (§5), since it is a session that does not exist yet.
 */
export function TilesView({ sessions, launching, expanded, onToggle, onOpenChat }: ViewProps) {
  return (
    <div className="tiles">
      {launching.map(p => <LaunchTile key={p.sessionId} entry={p} />)}
      {sessions.map(s => (
        <Tile key={s.id} s={s} open={expanded.has(s.id)} onToggle={() => onToggle(s.id)} onOpenChat={() => onOpenChat(s.id)} />
      ))}
    </div>
  );
}

function Tile({ s, open, onToggle, onOpenChat }: { s: Session; open: boolean; onToggle: () => void; onOpenChat: () => void }) {
  return (
    <div className={`s-card sm tile ${s.status}${open ? ' selected' : ''}`} onClick={onToggle} onKeyDown={keyActivate(onToggle)} tabIndex={0} role="button" aria-expanded={open}>
      <div className="tile-h">
        <Dot status={s.status} />
        <span className="nm">{s.sessionName || s.project}</span>
        <ChatButton s={s} onOpenChat={onOpenChat} />
      </div>
      <div className="tile-sub"><Tags s={s} withTitle={false} /></div>
      <div className="tile-metric">
        <Pct s={s} big />
        <span className="of">{fmtTok(s.tokens)} / {s.contextWindowLabel} context</span>
      </div>
      <Bar s={s} track />
      <ActLine s={s} />
      {open && <Expanded s={s} />}
    </div>
  );
}

function LaunchTile({ entry }: { entry: LaunchingSession }) {
  const { text, failed } = launchState(entry);
  return (
    <div className={`s-card sm tile launching${failed ? ' failed' : ''}`}>
      <div className="tile-h"><Dot status={failed ? 'failed' : 'launching'} /><span className="nm">{entry.projectName}</span><LaunchPill entry={entry} /></div>
      <div className="tile-sub"><span className="model">claude -p · launching from the dashboard</span></div>
      <div className="prompt">{text}</div>
    </div>
  );
}
