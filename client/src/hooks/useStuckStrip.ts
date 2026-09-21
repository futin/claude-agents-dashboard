import { useEffect, useRef, useState } from 'react';

import { nextStuck } from '../lib/stickyStrip';

/**
 * Is the phone's aside strip pinned under the nav bar? Drives the one class
 * that takes it full-bleed (`.s-strip.stuck`).
 *
 * The pin offset is `--mnav-h` and nothing else: the strip's `top` is fixed at
 * the bar's height, and the bar's auto-hide is answered by a transform on top
 * of that (styles.css), so where sticky *engages* never moves. Reading the
 * offset from the same token the strip resolves its `top` through is what keeps
 * the two from drifting apart.
 *
 * Below `xl` (1280px) nothing in the app is a scroll container — the pinned
 * `.wide` shells start there — so the document is what moves and `window` is
 * what to listen to, exactly as `useHideOnScroll` does.
 *
 * @param enabled  Phone measure only. Off, nothing is observed and the class is
 *                 released — a desktop never draws the strip at all.
 */
export function useStuckStrip(enabled: boolean) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setStuck(false);
      return;
    }
    const read = (): void => {
      const el = sentinel.current;
      if (!el) return;
      const root = getComputedStyle(document.documentElement);
      // `.shell{zoom:var(--font-scale)}` leaves rects in *visual* px while the
      // token is in CSS px — the same correction `useFloatingTip` makes.
      const z = parseFloat(root.getPropertyValue('--font-scale')) || 1;
      const pin = parseFloat(root.getPropertyValue('--mnav-h')) || 60;
      const top = el.getBoundingClientRect().top / z;
      setStuck(was => nextStuck(top, pin, was));
    };
    // Coalesced to a frame: a scroll fires far more often than the page can
    // paint, and this one does read layout.
    let raf = 0;
    const onScroll = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; read(); });
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [enabled]);

  return { sentinel, stuck };
}
