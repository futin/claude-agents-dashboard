import { useState } from 'react';

import type { LaunchingSession, Session } from '../../../shared/types';
import { SessionRow } from './SessionRow';

interface Props {
  sessions: Session[] | null;
  /**
   * In-flight `claude -p` launches (server/lib/spawn.ts's RAM-only store),
   * rendered as phantom rows above the real ones. A launch the scan has
   * adopted (or that `stopLaunch` killed) simply stops appearing on the next
   * poll — there is no client-side reconciliation to do here.
   */
  launching?: LaunchingSession[];
  /** Open the chat-history drawer for a session (state lives in SessionsView). */
  onOpenChat: (id: string) => void;
}

/** One launch still being watched: project, truncated prompt, and a state word — never interactive. */
function LaunchingRow({ entry }: { entry: LaunchingSession }) {
  const failed = entry.state === 'failed';
  return (
    <div className={`row launching${failed ? ' failed' : ''}`}>
      <div className="row-main">
        <div className="r1">
          <span className="dot" />
          <span className="proj">{entry.projectName}</span>
        </div>
        <div className="r2">
          <span className="status">{failed ? 'failed' : 'starting…'}</span>
          <span className="act" title={failed ? entry.error : entry.prompt}>
            {failed ? (entry.error || 'launch failed') : entry.prompt}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The rows container, with loading / empty states. Owns which rows are expanded. */
export function SessionList({ sessions, launching, onOpenChat }: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds(cur => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // A resume's id already names a real row below — its `launching` phantom
  // would be a duplicate, so only its FAILURE is worth a row of its own.
  const phantoms = (launching ?? []).filter(l => !l.resume || l.state === 'failed');

  if (sessions === null) {
    return (
      <div className="rows">
        <div className="empty"><div className="e">◌</div>Loading…</div>
      </div>
    );
  }
  // A launching entry stands on its own — it must still show even when the
  // filtered session list is empty (a fresh dashboard, or filters that
  // happen to exclude every real row right now).
  if (!sessions.length && !phantoms.length) {
    return (
      <div className="rows">
        <div className="empty"><div className="e">◌</div>No recent sessions in the lookback window.</div>
      </div>
    );
  }
  return (
    <div className="rows">
      {phantoms.map(p => <LaunchingRow key={p.sessionId} entry={p} />)}
      {sessions.map(s => (
        <SessionRow
          key={s.id}
          s={s}
          selected={expandedIds.has(s.id)}
          onToggle={() => toggle(s.id)}
          onOpenChat={() => onOpenChat(s.id)}
        />
      ))}
    </div>
  );
}
