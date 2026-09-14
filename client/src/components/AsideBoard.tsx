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
  if (!hasBoard(data, remoteAnswer)) return null;

  return (
    <div className="s-card">
      <div className="board-h">
        <div className="ct">Board</div>
        {data && <span className="clock">{boardClock(data)}</span>}
      </div>
      <BoardBody data={data} remoteAnswer={remoteAnswer} onOpenSpawn={onOpenSpawn} />
    </div>
  );
}

/**
 * Nothing to frame yet — neither poll has answered. Drawing the card would
 * flash an empty one on every cold load, and the phone strip has the same
 * problem, so both ask here.
 */
export function hasBoard(data: SessionsResponse | null, remoteAnswer: RemoteAnswerControl): boolean {
  return Boolean(data || remoteAnswer.state);
}

/** The clock the card's head and the strip's collapsed row both print. */
export const boardClock = (data: SessionsResponse): string =>
  new Date(data.generatedAt).toLocaleTimeString();

/**
 * The same predicate the board's "Needs you" column sorts on, so the count and
 * the column can never disagree: every remote hold, plus a terminal question
 * the hook did not hold. A count labelled "need you" must not omit a row that
 * visibly says it needs you.
 */
export const boardHolds = (data: SessionsResponse | null): number =>
  data ? triageGroups(data.sessions).needs.length : 0;

/**
 * Everything under the title. Shared with the phone strip's panel, which opens
 * onto exactly this rather than a second drawing of it.
 *
 * `launch` is the one difference between the two. The card carries **New
 * session** because the card is the only place to start one from; the strip
 * carries a square `+` that never scrolls away, so repeating the action inside
 * its panel would be the same control twice.
 */
export function BoardBody({ data, remoteAnswer, onOpenSpawn, launch = true }: {
  data: SessionsResponse | null;
  remoteAnswer: RemoteAnswerControl;
  onOpenSpawn: () => void;
  launch?: boolean;
}) {
  const holds = boardHolds(data);
  return (
    <>
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
      {launch && <div className="board-rule" />}
      {launch && remoteAnswer.state?.spawnAvailable && (
        <button type="button" className="newbtn" onClick={onOpenSpawn}>+ New session</button>
      )}
    </>
  );
}
