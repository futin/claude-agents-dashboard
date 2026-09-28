import { useSyncExternalStore } from 'react';

/**
 * Is the viewport the phone measure?
 *
 * One of the two places JS gets to know about a breakpoint (the other is
 * `useShellNarrow` below, at the shell's own 640). Layout is CSS's job here and
 * stays there; these exist for the questions CSS cannot answer — *which shapes
 * the switcher offers*, *which options a `<select>` lists*, *where the one
 * account chip is drawn* — where hiding with `display:none` would leave a
 * button in the tab order and an option still selectable by keyboard.
 *
 * 767.98px mirrors `styles.css`'s `md` density tier, and has to keep mirroring
 * it: the shapes withheld here are `list` and `split` (`WIDE_ONLY_LAYOUTS` in
 * `lib/filterSort.ts`, `WIDE_ONLY_AN_LAYOUTS` in `lib/analyticsFilterSort.ts`)
 * — the ones whose CSS stops working below `md`: `.split`'s two-column grid
 * and `.ledger`'s model column (the `list` shape renders as `.ledger`; see
 * `styles.css`'s `min-width:768px` block), not the shell's rail-to-top-bar
 * switch at 640, which is `useShellNarrow` below. `.board` and `.tiles` are never withheld — they're two of
 * the shapes that still show up narrow, and `.board` doesn't even turn at
 * `md` (its own only breakpoint is `xl`, 1280). The fractional value keeps
 * this query a true complement of the CSS's `min-width:768px`, with no gap
 * at fractional viewport widths.
 *
 * `useSyncExternalStore` rather than an effect + state, so the first paint has
 * the real answer instead of a desktop guess it corrects a frame later.
 */
export const NARROW_PX = 767.98;

/**
 * The *shell* boundary, `sm` (640) — a different question from `NARROW_PX`
 * above, and the reason this file exports two.
 *
 * 640 is where the rail comes back to the left edge, the phone bar and its
 * burger go away, and the board stops being full-bleed. The account chip has
 * one home either side of it — the header band from `sm`, the phone bar below
 * — and `App` picks between them here rather than in CSS, because the loser
 * would otherwise stay a tab stop with a popover still reachable by script.
 *
 * Using `NARROW_PX` for that would have been wrong by a whole band: between
 * 640 and 767 the phone bar is already hidden, so the chip would have been
 * handed to an element that draws nothing.
 *
 * Fractional for the same reason `NARROW_PX` is: a true complement of the
 * CSS's `min-width:640px`, with no gap at fractional viewport widths.
 */
export const SHELL_NARROW_PX = 639.98;

const QUERY = `(max-width:${NARROW_PX}px)`;
const SHELL_QUERY = `(max-width:${SHELL_NARROW_PX}px)`;

/** One `useSyncExternalStore` triple per query, built once at module scope. */
function matcher(query: string) {
  return {
    subscribe(onChange: () => void): () => void {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    snapshot: (): boolean => window.matchMedia(query).matches,
    /** Server snapshot: there is no server render here, and no width to report. */
    serverSnapshot: (): boolean => false
  };
}

const density = matcher(QUERY);
const shell = matcher(SHELL_QUERY);

export function useNarrow(): boolean {
  return useSyncExternalStore(density.subscribe, density.snapshot, density.serverSnapshot);
}

/** Is the viewport below the shell's `sm` (640px) rail-to-top-bar switch? */
export function useShellNarrow(): boolean {
  return useSyncExternalStore(shell.subscribe, shell.snapshot, shell.serverSnapshot);
}
