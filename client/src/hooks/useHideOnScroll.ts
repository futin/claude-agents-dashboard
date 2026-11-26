import { useEffect, useRef, useState } from 'react';

import { hideStep, scrollFloor } from '../lib/hideOnScroll';

/**
 * True while the reader is scrolling *down* the page — what the phone's top bar
 * reads as "get out of the way". Back to false on the first upward move. It
 * goes on the first pixels of the gesture rather than after a run-up: the bar
 * is in the way from the first line you scroll past, so waiting for a distance
 * only makes it linger.
 *
 * The one exception is the page's own top inset. Until `--body-pad` has gone
 * under the bar there is no *content* under it yet, so hiding it only opens a
 * band of empty board — and on the sessions page it opened a real gap: the
 * strip pins once that inset has scrolled away, so a bar that left earlier was
 * gone while the strip was still flowing. Coming back has no floor; up is
 * always immediate.
 *
 * `frozen` pins it open: the menu hangs off the bar, so a bar that slides away
 * under an open panel takes the panel's anchor with it.
 *
 * Reads `window.scrollY` and not an element's: below `xl` (1280px) nothing in
 * the app is a scroll container — the pinned `.wide` shells start there — so
 * the document is what moves. The listener is passive and does one property
 * read:
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
    // The inset, in the same space `scrollY` reports: `.shell{zoom}` renders
    // the token at `--font-scale` times its CSS px, and the root scroller is
    // outside that zoom — the correction `useFloatingTip` makes, multiplying
    // rather than dividing because this goes the other way.
    const root = getComputedStyle(document.documentElement);
    const floor = scrollFloor(root.getPropertyValue('--body-pad'), root.getPropertyValue('--font-scale'));
    const onScroll = (): void => {
      const step = hideStep(last.current, window.scrollY, floor);
      if (!step) return;
      last.current = step.last;
      setHidden(step.hidden);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [frozen]);

  return hidden;
}
