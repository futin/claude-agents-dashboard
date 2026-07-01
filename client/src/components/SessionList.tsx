import { useState } from 'react';

import type { Session } from '../../../shared/types';
import { SessionRow } from './SessionRow';

/** The rows container, with loading / empty states. Owns which row is expanded. */
export function SessionList({ sessions }: { sessions: Session[] | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
          selected={s.id === selectedId}
          onToggle={() => setSelectedId(cur => (cur === s.id ? null : s.id))}
        />
      ))}
    </div>
  );
}
