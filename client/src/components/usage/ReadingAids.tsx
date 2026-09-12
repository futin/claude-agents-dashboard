import type { PinHandlers } from '../../hooks/useFloatingTip';

/**
 * The ⓘ that opens a definition — the one reading aid both Usage tabs render
 * inline. The other half, the sheet that prints every definition at once, is
 * `Definitions` in `Sheet.tsx`: it is page chrome now rather than a drawer.
 *
 * Extracted at the second consumer, exactly as `useFloatingTip` was — and not
 * for the dozen lines of JSX. The glyph carries behaviour that is invisible in
 * a copy: `aria-expanded` is rendered here once as `false` and thereafter
 * mutated on the DOM node by hand by the hook, because pinning must not
 * re-render the rows. A hand-copied button that renders that attribute wrong,
 * or omits it, breaks pinning silently, in whichever tab nobody was looking at.
 *
 * Presentational only — no state, no hook, no fetch. `pin` is the caller's own
 * `pinHandlers`, so each tab keeps exactly one floating panel.
 */

/**
 * One ⓘ glyph.
 *
 * `label` is the term's own words, lowercase, not a sentence: the button reads
 * them out as "What is the &lt;label&gt;?".
 */
export function InfoDot({ label, text, pin }: {
  label: string;
  text: string;
  pin: (text: string) => PinHandlers;
}) {
  return (
    <button
      type="button"
      className="idot"
      aria-label={`What is the ${label}?`}
      aria-expanded="false"
      {...pin(text)}
    >i</button>
  );
}
