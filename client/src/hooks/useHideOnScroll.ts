import { useEffect, useRef, useState } from 'react';

/**
 * True while the reader is scrolling *down* the page — what the phone's top bar
 * reads as "get out of the way". Back to false on the first upward move. It
 * goes on the first few pixels of the gesture rather than after a run-up: the
 * bar is in the way from the first line you scroll past, so waiting for a
 * distance only makes it linger.
 *
 * `frozen` pins it open: the menu hangs off the bar, so a bar that slides away
 * under an open panel takes the panel's anchor with it.
 *
 * Reads `window.scrollY` and not an element's: below 700px nothing in the app
 * is a scroll container — the pinned `.wide` shells start at 1201px — so the
 * document is what moves. The listener is passive and does one property read:
 * `scrollY` is already current inside a scroll handler, so this forces no
 * layout and never needs a frame of its own to be cheap.
 */
export function useHideOnScroll(frozen: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);

  useEffect(() => {
    if (frozen) {
      setHidden(false);
      return;
    }
    last.current = Math.max(0, window.scrollY);
    const onScroll = (): void => {
      // iOS rubber-banding reports a negative scrollY past the top; clamped, so
      // the release upward isn't read as a downward move.
      const y = Math.max(0, window.scrollY);
      const dy = y - last.current;
      // A dead band of a few pixels, not a raw sign test: a one-pixel jitter
      // (or the layout shift of a row that just came in from the poll) must not
      // toggle it. Small enough that a real flick reads as one straight away.
      if (Math.abs(dy) < 3) return;
      last.current = y;
      // No floor on `y`: hiding starts with the gesture. Except *at* the top,
      // where there is nothing scrolled past yet and the bar has nothing to get
      // out of the way of.
      setHidden(dy > 0 && y > 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [frozen]);

  return hidden;
}
