import { useState } from 'react';

import type { SessionsResponse } from '../../../../shared/types';
import type { RemoteAnswerControl } from '../../hooks/useRemoteAnswer';
import { useStuckStrip } from '../../hooks/useStuckStrip';
import { AccountBody, accountSummary, hasAccount } from '../AsideAccount';
import { BoardBody, boardClock, boardHolds, hasBoard } from '../AsideBoard';

/**
 * The sessions aside at a phone measure: the Account and Board cards collapsed
 * into one 48px bar that pins under the nav, so the list starts about a thumb
 * from the top instead of two full cards down.
 *
 * The bar is two taps and a button. Left: the rate-window percentages, opening
 * onto the Account card's gauges. Right: the "needs you" count and the clock,
 * opening onto the Board card's facts. Then the square **+**, which is the
 * launch action promoted out of the Board card — on a phone the one write
 * action should not be two taps and a scroll away.
 *
 * A panel prints its own **Account** / **Board** title, which the collapsed bar
 * has no room for; open, it is the desktop card's body verbatim
 * (`AccountBody`, `BoardBody`) rather than a second drawing of it.
 *
 * Pinned, the bar goes full-bleed: the page padding is cancelled, the radius
 * drops to 0 and the shadow becomes a hairline, so a stuck bar reads as part of
 * the nav above it rather than as a card floating over the list. It travels
 * with that bar — the nav auto-hides going down the page and the strip rises
 * into the space it leaves, as one transform on the same `.22s` curve
 * (styles.css). Where it pins never moves, which is what lets that be a
 * transform: `lib/stickyStrip.ts`.
 *
 * Only one panel is open at a time: they are two halves of one bar, and both
 * down is a card taller than the screen with the list nowhere in sight.
 */
export function AsideStrip({ data, remoteAnswer, onOpenSpawn }: {
  data: SessionsResponse | null;
  remoteAnswer: RemoteAnswerControl;
  onOpenSpawn: () => void;
}) {
  const [open, setOpen] = useState<'account' | 'board' | null>(null);
  const account = hasAccount(data);
  const board = hasBoard(data, remoteAnswer);
  // Enabled only once there is a bar to pin: with both halves empty nothing is
  // rendered and the sentinel does not exist.
  const { sentinel, stuck } = useStuckStrip(account || board);

  if (!account && !board) return null;

  const toggle = (which: 'account' | 'board') => (): void =>
    setOpen(cur => (cur === which ? null : which));
  const gauges = accountSummary(data);
  const holds = boardHolds(data);

  return (
    <>
      {/* Zero-height and never sticky: the fixed mark the pinned test is
          taken against. It has to sit outside `.s-strip`, which moves. */}
      <div ref={sentinel} className="s-strip-mark" aria-hidden="true" />
      <div className={`s-strip${stuck ? ' stuck' : ''}`}>
        <div className="s-strip-row">
          {account && (
            <button
              type="button"
              className={`s-strip-tap${open === 'account' ? ' open' : ''}`}
              aria-expanded={open === 'account'}
              onClick={toggle('account')}
            >
              {gauges.map(g => (
                <span key={g.label} className="s-mini">
                  <span className="k">{g.label}</span>
                  <span className={`v ${g.level}`.trim()}>{g.pct}%</span>
                </span>
              ))}
              {/* No gauge to print yet (SHOW_USAGE off is filtered above, so
                  this is a cold poll): the half still has to be tappable and
                  say what it opens. */}
              {gauges.length === 0 && <span className="s-mini"><span className="k">Account</span></span>}
              <Caret />
            </button>
          )}
          {account && board && <span className="s-strip-sep" aria-hidden="true" />}
          {board && (
            <button
              type="button"
              className={`s-strip-tap s-tap-board${open === 'board' ? ' open' : ''}`}
              aria-expanded={open === 'board'}
              onClick={toggle('board')}
            >
              {/* The one board fact worth seeing without opening anything. */}
              {holds > 0 && <span className="s-strip-badge">{holds} ask</span>}
              {data && <span className="s-strip-clock">{boardClock(data)}</span>}
              <Caret />
            </button>
          )}
          {remoteAnswer.state?.spawnAvailable && (
            <button type="button" className="s-plus" onClick={onOpenSpawn} aria-label="New session">
              {/* Drawn, not typed. A text "+" is centred by its line box, and
                  the glyph's ink sits above that centre — it read high in the
                  square. Two strokes are centred by construction. */}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
            </button>
          )}
        </div>
        {open === 'account' && (
          <div className="s-strip-panel">
            <div className="ct">Account</div>
            <AccountBody data={data} />
          </div>
        )}
        {open === 'board' && (
          <div className="s-strip-panel">
            <div className="ct">Board</div>
            <BoardBody data={data} remoteAnswer={remoteAnswer} onOpenSpawn={onOpenSpawn} launch={false} />
          </div>
        )}
      </div>
    </>
  );
}

/** Points down closed, and is flipped by CSS on the half that is open. */
const Caret = () => (
  <svg className="s-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
