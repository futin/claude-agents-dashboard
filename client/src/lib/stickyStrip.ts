/**
 * When the phone's aside strip is *pinned* — the one decision behind its
 * full-bleed shape (`.s-strip.stuck`, styles.css §Sessions aside strip).
 *
 * Pure and hysteretic, because the reading it works from is fractional and the
 * class it sets changes the element's own box: a single threshold let a
 * sub-pixel layout flip it back and forth on consecutive scroll ticks.
 *
 * The reading is taken from a zero-height **sentinel** parked at the strip's
 * unpinned position, never from the strip itself — the strip is what moves, and
 * while the nav bar is hiding it is mid-transition for 220ms.
 */

/** Fractional layout: the sentinel lands a hair off the offset it matches. */
const STICK_EPS = 0.5;
/** The release edge, far enough off the pin that the two cannot alias. */
const UNSTICK_SLACK = 2;

/**
 * @param sentinelTop  The sentinel's distance below the viewport top, in CSS
 *                     px (divide a `getBoundingClientRect()` reading by
 *                     `--font-scale` — `.shell{zoom}` makes rects visual px).
 * @param pin          Where the strip pins: `--mnav-h`, always. It is a fixed
 *                     `top` and the bar's auto-hide is a transform on top of
 *                     it, so this does not move.
 * @param wasStuck     The current class, kept inside the band.
 */
export function nextStuck(sentinelTop: number, pin: number, wasStuck: boolean): boolean {
  if (sentinelTop <= pin + STICK_EPS) return true;
  if (sentinelTop > pin + UNSTICK_SLACK) return false;
  return wasStuck;
}
