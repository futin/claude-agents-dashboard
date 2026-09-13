import type { SessionsResponse } from '../../../shared/types';
import type { RemoteAnswerControl } from '../hooks/useRemoteAnswer';
import { triageGroups } from '../lib/triage';
import { OriginBadge } from './OriginBadge';
import { RemoteAnswerToggle } from './RemoteAnswerToggle';

/**
 * The Board card in the sessions aside: everything true of the whole board
 * rather than of the list — the clock, how this browser reached the server,
 * the counts, whether remote answers are allowed, and the one write action
 * (New session). Everything that filters or orders the list stays in the
 * Toolbar, which is the whole point of the split.
 */
export function AsideBoard({ data, remoteAnswer, onOpenSpawn }: {
  data: SessionsResponse | null;
  /**
   * Owned by `SessionsView` and passed down rather than called here: the spawn
   * panel needs `spawnMaxPermission` off the same `/api/health` snapshot, and a
   * second `useRemoteAnswer()` call site would mean a second poll.
   */
  remoteAnswer: RemoteAnswerControl;
  /** Open the launch panel (its open/closed state lives in SessionsView). */
  onOpenSpawn: () => void;
}) {
  // Nothing to frame yet — neither poll has answered. Drawing the card here
  // would flash an empty one on every cold load.
  if (!data && !remoteAnswer.state) return null;

  const clock = data ? new Date(data.generatedAt).toLocaleTimeString() : '';
  // The same predicate the board's "Needs you" column sorts on, so the count
  // and the column can never disagree: every remote hold, plus a terminal
  // question the hook did not hold. A count labelled "need you" must not omit
  // a row that visibly says it needs you.
  const holds = data ? triageGroups(data.sessions).needs.length : 0;

  return (
    <div className="s-card">
      <div className="board-h">
        <div className="ct">Board</div>
        {clock && <span className="clock">{clock}</span>}
      </div>
      <div className="cs">Board-wide counts, and how this browser reached the server</div>
      <div className="cs board-sub">
        <OriginBadge origin={remoteAnswer.state?.origin} />
      </div>
      {data && (
        <div className="facts">
          <div className="fact"><span>Active sessions:</span><b>{data.totals.active}</b></div>
          {/* No `title`: it is dead on touch, and this board is read on a phone. */}
          <div className="fact"><span>Need you:</span><b className={holds ? 'hot' : ''}>{holds}</b></div>
          <div className="fact"><span>Rows shown:</span><b>Top {data.maxSessions}</b></div>
          {data.runningClaudeProcs != null && (
            <div className="fact"><span>Claude processes:</span><b>{data.runningClaudeProcs}</b></div>
          )}
        </div>
      )}
      <RemoteAnswerToggle control={remoteAnswer} />
      <div className="board-rule" />
      {remoteAnswer.state?.spawnAvailable && (
        <button type="button" className="newbtn" onClick={onOpenSpawn}>+ New session</button>
      )}
    </div>
  );
}
