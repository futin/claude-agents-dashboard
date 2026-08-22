/**
 * PanelChrome.tsx — the head row every wait panel shares, and the one-line stub
 * it collapses to.
 *
 * Split out of the three panels (question / plan / message) so the caret sits in
 * the same corner in each: the reader learns "top-right shrinks this" once.
 *
 * The state itself stays in each panel, reset whenever its pending id changes —
 * so a NEW ask always arrives expanded. Minimising is a decision about the ask
 * in front of you, never a standing preference; a collapsed panel that outlived
 * its question would be a wait you can miss.
 */

import type { ReactNode } from 'react';

export function PanelHead({ badge, hint, onMinimise }: {
  badge: string;
  /** Right of the badge — the same short line the panel showed before. */
  hint: ReactNode;
  onMinimise: () => void;
}) {
  return (
    <div className="qp-head">
      <span className="qp-badge">{badge}</span>
      <span className="qp-hint">{hint}</span>
      <span className="spacer" />
      <button
        type="button"
        className="qp-min"
        aria-expanded={true}
        aria-label="Minimise this panel"
        title="Minimise — read the chat, then expand to answer"
        onClick={onMinimise}
      >
        ▾
      </button>
    </div>
  );
}

/**
 * The collapsed panel: badge, `collapsedSummary()` text, caret. The whole row is
 * the expand button, since on a phone a caret-sized target is a miss waiting to
 * happen.
 */
export function MinimisedPanel({ badge, summary, onExpand }: {
  badge: string;
  summary: string;
  onExpand: () => void;
}) {
  return (
    <div className="qpanel min">
      <span className="qp-badge">{badge}</span>
      <button
        type="button"
        className="qp-minrow"
        aria-expanded={false}
        aria-label={`Expand this panel — ${summary}`}
        onClick={onExpand}
      >
        <span className="qp-hint">{summary}</span>
        <span className="spacer" />
        <span className="qp-min" aria-hidden="true">▴</span>
      </button>
    </div>
  );
}
