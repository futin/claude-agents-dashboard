import { useState } from 'react';

import type { Session } from '../../../shared/types';
import { SessionRow } from './SessionRow';

/** The rows container, with loading / empty states. Owns which rows are expanded. */
export function SessionList({ sessions }: { sessions: Session[] | null }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds(cur => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (sessions === null) {
    return (
      <div className="rows">
        <div className="empty"><div className="e">◌</div>Loading…</div>
      </div>
    );
  }
  if (!sessions.length) {
    return (
      <div className="rows">
        <div className="empty"><div className="e">◌</div>No recent sessions in the lookback window.</div>
      </div>
    );
  }
  return (
    <div className="rows">
      {sessions.map(s => (
        <SessionRow
          key={s.id}
          s={s}
          selected={expandedIds.has(s.id)}
          onToggle={() => toggle(s.id)}
        />
      ))}
    </div>
  );
}
