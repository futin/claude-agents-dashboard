import type { Session } from '../../../shared/types';
import { SessionRow } from './SessionRow';

/** The rows container, with loading / empty states. */
export function SessionList({ sessions }: { sessions: Session[] | null }) {
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
      {sessions.map(s => <SessionRow key={s.id} s={s} />)}
    </div>
  );
}
