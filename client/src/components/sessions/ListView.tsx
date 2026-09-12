import { Fragment } from 'react';

import type { LaunchingSession, Session } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { ActLine, Bar, ChatButton, Dot, LaunchPill, Pct, Tok, keyActivate, launchState } from './atoms';
import { surfacePill } from '../../lib/surface';
import { Expanded } from './Expanded';
import type { ViewProps } from './views';

/**
 * One table. The open row expands underneath itself across every column, so
 * the timeline gets the full width the cards cannot give it.
 */
export function ListView({ sessions, launching, expanded, onToggle, onOpenChat }: ViewProps) {
  return (
    <div className="s-card ledger">
      <table>
        <colgroup>
          <col className="c-dot" /><col /><col className="c-model" /><col className="c-ctx" /><col /><col className="c-last" /><col className="c-do" />
        </colgroup>
        <thead>
          <tr>
            <th /><th>Session</th><th>Model</th><th>Context</th><th>Activity</th><th className="when">Last</th><th />
          </tr>
        </thead>
        <tbody>
          {launching.map(p => <LaunchRow key={p.sessionId} entry={p} />)}
          {sessions.map(s => {
            const open = expanded.has(s.id);
            return (
              <Fragment key={s.id}>
                <Row s={s} open={open} onToggle={() => onToggle(s.id)} onOpenChat={() => onOpenChat(s.id)} />
                {open && (
                  <tr className="expand"><td colSpan={7}><Expanded s={s} /></td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Row({ s, open, onToggle, onOpenChat }: { s: Session; open: boolean; onToggle: () => void; onOpenChat: () => void }) {
  const surface = surfacePill(s.surface);
  const sub = [s.sessionName ? s.project : null, s.gitBranch].filter(Boolean).join(' · ');
  return (
    <tr className={`${s.status}${open ? ' selected' : ''}`} onClick={onToggle} onKeyDown={keyActivate(onToggle)} tabIndex={0} aria-expanded={open}>
      <td><Dot status={s.status} /></td>
      <td>
        <div className="name">
          {s.sessionName || s.project}
          {surface && <span className={`ag-pill surface ${s.surface}`} title={surface.title}>{surface.label}</span>}
          {s.kaizenLesson && <span className="ag-pill kaizen" title={s.kaizenLesson}>kaizen</span>}
        </div>
        {sub && <div className="sub" title={sub}>{sub}</div>}
      </td>
      <td className="model">{s.model}</td>
      <td>
        <div className="ctx"><Bar s={s} /><Pct s={s} /></div>
        <Tok s={s} />
      </td>
      <td className="activity"><ActLine s={s} ago={false} /></td>
      <td className="when">{formatAgo(s.updatedMs)} ago</td>
      <td className="do"><ChatButton s={s} onOpenChat={onOpenChat} /></td>
    </tr>
  );
}

function LaunchRow({ entry }: { entry: LaunchingSession }) {
  const { text, failed } = launchState(entry);
  return (
    <tr className={`launching${failed ? ' failed' : ''}`}>
      <td><Dot status={failed ? 'failed' : 'launching'} /></td>
      <td><div className="name">{entry.projectName}</div><div className="sub">claude -p · not interactive</div></td>
      <td className="model"><span className="dash">—</span></td>
      <td><span className="dash">—</span></td>
      <td className="activity"><div className="act-line"><LaunchPill entry={entry} /><span className="act" title={text}>{text}</span></div></td>
      <td className="when"><span className="dash">—</span></td>
      <td className="do"><span className="dash">—</span></td>
    </tr>
  );
}
