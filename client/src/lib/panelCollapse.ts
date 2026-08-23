/**
 * panelCollapse.ts — the one line a minimised wait panel leaves behind.
 *
 * A pinned `.qpanel` is capped at 56vh (62vh on a phone), so a multi-question
 * ask squeezes the chat body it sits under to a few lines — exactly when the
 * reader needs to scroll the transcript back to decide what to answer.
 * Minimising drops the panel to a single row, and this is the text on it: what
 * is waiting, and how urgent it is. Pure, so it can be tested without a DOM.
 */

/** Which wait is minimised, plus whatever its stub has to say. */
export type CollapsedPanel =
  | { kind: 'question'; questions: number }
  | { kind: 'plan' }
  | { kind: 'message'; secsLeft: number };

/** Seconds as a compact countdown — `45s`, `2m`. Never negative. */
export function fmtLeft(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return s >= 120 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

export function collapsedSummary(panel: CollapsedPanel): string {
  switch (panel.kind) {
    case 'question': {
      // Clamped: a stub reading "0 questions" would be worse than one that
      // under-promises, and the store never holds an empty question set.
      const n = Math.max(1, Math.floor(panel.questions));
      return `${n} question${n === 1 ? '' : 's'} · tap to answer`;
    }
    case 'plan':
      return 'plan waiting · revise from here';
    case 'message':
      return `closes in ${fmtLeft(panel.secsLeft)}`;
  }
}
