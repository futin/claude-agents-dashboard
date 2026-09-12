import type { LaunchingSession, Session } from '../../../../shared/types';
import { fmtTok, formatAgo } from '../../lib/format';
import { STATUS_LABEL } from '../../lib/filterSort';
import { chatTab } from '../../lib/holds';
import { stopControl } from '../../lib/stopControl';
import { surfacePill } from '../../lib/surface';

/**
 * The pieces every view draws a session out of. State rides on the element
 * itself (`.sdot.working`, `.spill.question`) rather than on an ancestor row,
 * because the same session sits in a card, a table cell, a list row and a tile.
 */

/**
 * Enter or Space on a clickable container does what a click does. The four
 * views that open a session on click give their container `tabIndex={0}` and
 * this handler, so the board is reachable without a pointer.
 */
export function keyActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;   // a button inside handles its own keys
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
  };
}

/** Context ≥ 70% turns the figure and the bar amber — one threshold, one place. */
export function ctxWarn(s: Session): boolean {
  return (s.contextPct || 0) >= 70;
}

export function Dot({ status }: { status: Session['status'] | 'launching' | 'failed' }) {
  return <span className={`sdot ${status}`} aria-hidden="true" />;
}

export function StatusPill({ s }: { s: Session }) {
  return <span className={`spill ${s.status}`}>{STATUS_LABEL[s.status]}</span>;
}

/** The session's name (custom title, else project) as the row's lead. */
export function Title({ s }: { s: Session }) {
  return <span className="sname">{s.sessionName || s.project}</span>;
}

/**
 * Project pill (only when a custom title leads), branch, model, and the two
 * optional pills — surface and kaizen. Same rule as before: the pills carry no
 * handler of their own, so a click on them does what a click on the row does.
 */
export function Tags({ s, withTitle = true }: { s: Session; withTitle?: boolean }) {
  const surface = surfacePill(s.surface);
  return (
    <>
      {withTitle && <Title s={s} />}
      {s.sessionName && <span className="proj-pill">{s.project}</span>}
      {s.gitBranch && <span className="branch" title={s.gitBranch}>{s.gitBranch}</span>}
      <span className="model">{s.model}</span>
      {surface && <span className={`ag-pill surface ${s.surface}`} title={surface.title}>{surface.label}</span>}
      {s.kaizenLesson && <span className="ag-pill kaizen" title={s.kaizenLesson}>kaizen</span>}
    </>
  );
}

export function Tok({ s }: { s: Session }) {
  return <span className="tok">{fmtTok(s.tokens)} / {s.contextWindowLabel}</span>;
}

export function Pct({ s, big = false }: { s: Session; big?: boolean }) {
  const cls = big ? 'metric' : 'pct';
  return <span className={`${cls}${ctxWarn(s) ? ' warn' : ''}`}>{s.contextPct || 0}%</span>;
}

/** The 8px context bar (10px as `track` in the metric tiles and the inspector). */
export function Bar({ s, track = false }: { s: Session; track?: boolean }) {
  const pct = Math.min(100, s.contextPct || 0);
  return (
    <div className={track ? 'track' : 'bar'}>
      <div className={`fill${ctxWarn(s) ? ' warn' : ''}`} style={{ width: pct + '%' }} />
    </div>
  );
}

/** The current tool call, or "no tool activity". */
export function Act({ s }: { s: Session }) {
  if (!s.activity) return <span className="act none">no tool activity</span>;
  return (
    <span className="act">
      <span className={`tool${s.activity.tool === 'Task' ? ' task' : ''}`}>{s.activity.tool}</span>
      {s.activity.detail ? ' ' + s.activity.detail : ''}
    </span>
  );
}

/**
 * Status pill · activity · (stopping…) · ago. The `stopping…` badge is visible
 * text, never a `title` — a tooltip is dead on touch, and the phone is the
 * surface the stop control exists for.
 */
export function ActLine({ s, ago = true }: { s: Session; ago?: boolean }) {
  const ctl = stopControl(s.stopState, false);
  return (
    <div className="act-line">
      <StatusPill s={s} />
      <span aria-hidden="true">·</span>
      <Act s={s} />
      {ctl.render && ctl.badge && <span className="stop-badge">{ctl.badge}</span>}
      {ago && <span className="ago">{formatAgo(s.updatedMs)} ago</span>}
    </div>
  );
}

/**
 * The way into a session's chat drawer, and where it names a hold. Stops the
 * click from reaching the card it sits in, so opening the drawer never also
 * toggles the row.
 */
export function ChatButton({ s, onOpenChat, wide = false }: { s: Session; onOpenChat: () => void; wide?: boolean }) {
  const tab = chatTab(s);
  return (
    <button
      type="button"
      className={`cbtn${tab.tone ? ' ' + tab.tone : ''}${wide ? ' wide' : ''}`}
      onClick={e => { e.stopPropagation(); onOpenChat(); }}
      title={tab.title}
      aria-label={tab.title}
    >
      {tab.label} <span className="rc-mark" aria-hidden="true">▸</span>
    </button>
  );
}

/** The state word on a phantom launch, and the line under it. */
export function launchState(entry: LaunchingSession): { word: string; text: string; failed: boolean } {
  const failed = entry.state === 'failed';
  return {
    failed,
    word: failed ? 'failed' : 'starting…',
    text: failed ? (entry.error || 'launch failed') : entry.prompt
  };
}

export function LaunchPill({ entry }: { entry: LaunchingSession }) {
  const { word, failed } = launchState(entry);
  return <span className={`spill ${failed ? 'failed' : 'launching'}`}>{word}</span>;
}
