import { useSyncExternalStore } from 'react';

/**
 * Is the viewport the phone measure?
 *
 * The one place JS gets to know about a breakpoint. Layout is CSS's job here
 * and stays there; this exists for the two questions CSS cannot answer —
 * *which shapes the switcher offers* and *which options a `<select>` lists* —
 * where hiding with `display:none` would leave a button in the tab order and
 * an option still selectable by keyboard.
 *
 * 767.98px mirrors `styles.css`'s `md` density tier, and has to keep mirroring
 * it: the shapes withheld here are `list` and `split` (`WIDE_ONLY_LAYOUTS` in
 * `lib/filterSort.ts`, `WIDE_ONLY_AN_LAYOUTS` in `lib/analyticsFilterSort.ts`)
 * — the ones whose CSS stops working below `md`: `.split`'s two-column grid
 * and `.ledger`'s model column (the `list` shape renders as `.ledger`; see
 * `styles.css`'s `min-width:768px` block), not the shell's rail-to-top-bar
 * switch at 640. `.board` and `.tiles` are never withheld — they're two of
 * the shapes that still show up narrow, and `.board` doesn't even turn at
 * `md` (its own only breakpoint is `xl`, 1280). The fractional value keeps
 * this query a true complement of the CSS's `min-width:768px`, with no gap
 * at fractional viewport widths.
 *
 * `useSyncExternalStore` rather than an effect + state, so the first paint has
 * the real answer instead of a desktop guess it corrects a frame later.
 */
export const NARROW_PX = 767.98;

const QUERY = `(max-width:${NARROW_PX}px)`;

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

const snapshot = (): boolean => window.matchMedia(QUERY).matches;

/** Server snapshot: there is no server render here, and no width to report. */
const serverSnapshot = (): boolean => false;

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
