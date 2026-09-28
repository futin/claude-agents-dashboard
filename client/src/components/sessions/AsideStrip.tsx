import { useState } from 'react';

import type { SessionsResponse } from '../../../../shared/types';
import type { RemoteAnswerControl } from '../../hooks/useRemoteAnswer';
import { useStuckStrip } from '../../hooks/useStuckStrip';
import { BoardBody, boardClock, boardHolds, hasBoard } from '../AsideBoard';

/**
 * The sessions aside at a phone measure: the Board card collapsed into one 48px
 * bar that pins under the nav, so the list starts about a thumb from the top
 * instead of a full card down.
 *
 * One tap and a button. The tap carries the "needs you" count and the clock and
 * opens onto the Board card's facts; then the square **+**, which is the launch
 * action promoted out of that card — on a phone the one write action should not
 * be two taps and a scroll away.
 *
 * The account half is gone from here. The rate windows are in the phone nav
 * bar's account chip (`HeaderAccount`) now, where they are readable from every
 * section rather than only from this list — and where they sit beside the
 * account's name, which this bar never had room for.
 *
 * The panel prints its own **Board** title, which the collapsed bar has no room
 * for; open, it is the desktop card's body verbatim (`BoardBody`) rather than a
 * second drawing of it.
 *
 * Pinned, the bar goes full-bleed: the page padding is cancelled, the radius
 * drops to 0 and the shadow becomes a hairline, so a stuck bar reads as part of
 * the nav above it rather than as a card floating over the list. It travels
 * with that bar — the nav auto-hides going down the page and the strip rises
 * into the space it leaves, as one transform on the same `.22s` curve
 * (styles.css). Where it pins never moves, which is what lets that be a
 * transform: `lib/stickyStrip.ts`.
 */
export function AsideStrip({ data, remoteAnswer, onOpenSpawn }: {
  data: SessionsResponse | null;
  remoteAnswer: RemoteAnswerControl;
  onOpenSpawn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const board = hasBoard(data, remoteAnswer);
  // Enabled only once there is a bar to pin: with nothing to say the strip is
  // not rendered and the sentinel does not exist.
  const { sentinel, stuck } = useStuckStrip(board);

  if (!board) return null;

  const holds = boardHolds(data);

  return (
    <>
      {/* Zero-height and never sticky: the fixed mark the pinned test is
          taken against. It has to sit outside `.s-strip`, which moves. */}
      <div ref={sentinel} className="s-strip-mark" aria-hidden="true" />
      <div className={`s-strip${stuck ? ' stuck' : ''}`}>
        <div className="s-strip-row">
          <button
            type="button"
            className={`s-strip-tap s-tap-board${open ? ' open' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen(v => !v)}
          >
            {/* The one board fact worth seeing without opening anything. */}
            {holds > 0 && <span className="s-strip-badge">{holds} ask</span>}
            {data && <span className="s-strip-clock">{boardClock(data)}</span>}
            <Caret />
          </button>
          {remoteAnswer.state?.spawnAvailable && (
            <button type="button" className="s-plus" onClick={onOpenSpawn} aria-label="New session">
              {/* Drawn, not typed. A text "+" is centred by its line box, and
                  the glyph's ink sits above that centre — it read high in the
                  square. Two strokes are centred by construction. */}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
            </button>
          )}
        </div>
        {open && (
          <div className="s-strip-panel">
            <div className="ct">Board</div>
            <BoardBody data={data} remoteAnswer={remoteAnswer} onOpenSpawn={onOpenSpawn} launch={false} />
          </div>
        )}
      </div>
    </>
  );
}

/** Points down closed, and is flipped by CSS on the tap that is open. */
const Caret = () => (
  <svg className="s-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
