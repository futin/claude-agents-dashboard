import type { PinHandlers } from '../../hooks/useFloatingTip';

/**
 * The two reading aids both Usage tabs render: the ⓘ that opens a definition,
 * and the closed-by-default drawer that lists every definition at once.
 *
 * Extracted at the second consumer, exactly as `useFloatingTip` was — and not
 * for the two dozen lines of JSX. The ⓘ carries behaviour that is invisible in
 * a copy: `aria-expanded` is rendered here once as `false` and thereafter
 * mutated on the DOM node by hand by the hook, because pinning must not
 * re-render the rows. A hand-copied button that renders that attribute wrong,
 * or omits it, breaks pinning silently, in whichever tab nobody was looking at.
 *
 * The `rates-*` class names are the shared vocabulary of these aids rather than
 * the token-value tab's private prefix. They are not renamed: `.claude/CLAUDE.md`
 * keeps class names stable, and a rename would touch both tabs and `styles.css`
 * for nothing a reader can see.
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
      className="rates-i"
      aria-label={`What is the ${label}?`}
      aria-expanded="false"
      {...pin(text)}
    >i</button>
  );
}

/**
 * The `How to read this` drawer.
 *
 * Typed against the structural shape rather than either tab's own glossary
 * type, so `RATES_GLOSSARY` and `profileGlossary(…)`'s return both satisfy it
 * without either module importing the other.
 */
export function HowToRead({ terms }: {
  terms: readonly { key: string; term: string; text: string }[];
}) {
  return (
    <details className="rates-how">
      <summary>
        How to read this <span className="rates-n">{terms.length} terms</span>
      </summary>
      <dl className="rates-gloss">
        {terms.map(g => (
          <div key={g.key}>
            <dt>{g.term}</dt>
            <dd>{g.text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
