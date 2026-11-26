import type { Session } from '../../../shared/types';

/** The context share at which the figure and the bar turn amber. */
export const CTX_WARN_PCT = 70;

/** Context ≥ 70% turns the figure and the bar amber — one threshold, one place, read by the session views and the chat drawer alike. */
export function ctxWarn(s: Pick<Session, 'contextPct'>): boolean {
  return (s.contextPct || 0) >= CTX_WARN_PCT;
}
