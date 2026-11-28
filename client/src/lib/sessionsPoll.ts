import type { SessionsResponse } from '../../../shared/types';

/**
 * What the sessions poll keeps after an answer. A failed scan answers 200 with `error: true` and empty rows; drawing that would read as "no sessions"
 * while the link still says live (#593). So, like `acceptSpend`, it keeps the last good snapshot — but takes `launching`, `usage` and `usageStatus` from
 * the new body, which the server attaches on the error snapshot on purpose (a failed scan is when "did my launch work?" matters most). With nothing good
 * yet it stays null, so nothing downstream (the board, GitView's Sync tracking) ever sees a fake empty list.
 */
export function acceptSessions(prev: SessionsResponse | null, incoming: SessionsResponse): SessionsResponse | null {
  if (!incoming.error) return incoming;
  if (!prev) return null;
  const { error: _drop, ...kept } = prev;
  return { ...kept, launching: incoming.launching, usage: incoming.usage, usageStatus: incoming.usageStatus };
}
