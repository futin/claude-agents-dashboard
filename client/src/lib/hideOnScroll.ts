/** The rules behind `useHideOnScroll`, the phone top bar's hide-on-scroll; the hook keeps the listener and the DOM reads. */

/**
 * The page's top inset in the space `scrollY` reports: `--body-pad` times `--font-scale`, from their raw computed strings. An unreadable inset is `0`, an
 * unreadable scale `1`.
 */
export function scrollFloor(bodyPad: string, fontScale: string): number {
  return (parseFloat(bodyPad) || 0) * (parseFloat(fontScale) || 1);
}

/**
 * One scroll event against the last position that counted. `null` means nothing changes — not the bar and not `last` — so a run of sub-band moves still adds
 * up to one that counts.
 *
 * iOS rubber-banding reports a negative scrollY past the top; clamped, so the release upward isn't read as a downward move. A dead band of a few pixels, not
 * a raw sign test: a one-pixel jitter (or the layout shift of a row that just came in from the poll) must not toggle it. Small enough that a real flick reads
 * as one straight away. Hiding starts with the gesture, once the page's top inset (`floor`) has actually passed under the bar.
 */
export function hideStep(last: number, scrollY: number, floor: number): { last: number; hidden: boolean } | null {
  const y = Math.max(0, scrollY);
  const dy = y - last;
  if (Math.abs(dy) < 3) return null;
  return { last: y, hidden: dy > 0 && y > floor };
}
