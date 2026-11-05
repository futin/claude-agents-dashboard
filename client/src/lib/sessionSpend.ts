import { fmtTok } from './format';
import type { SessionSpend } from '../../../shared/types';

export interface SpendCard {
  total: string;
  ariaLabel: string;
  /** Null when there is nothing to split: the total is the main agent's figure. */
  split: string | null;
}

/** The chat drawer's "Tokens spent" card. `≥` marks a total known to run low: a compaction call or a lost subagent turn is in the spend but not in the figure. */
export function spendCard(s: SessionSpend): SpendCard {
  const minimum = s.compactions > 0 || s.uncountedSubagents > 0;
  const total = fmtTok(s.total);
  return {
    total: minimum ? `≥ ${total}` : total,
    ariaLabel: `${minimum ? 'at least ' : ''}${total} tokens spent`,
    split: s.subagents > 0 || s.uncountedSubagents > 0 ? `main ${fmtTok(s.main)} · subagents ${fmtTok(s.subagents)}` : null
  };
}

/** A failed poll keeps the last good snapshot, so one bad read never blanks a figure that can only grow. */
export function acceptSpend(prev: SessionSpend | null, incoming: SessionSpend): SessionSpend | null {
  return incoming.error ? prev : incoming;
}
