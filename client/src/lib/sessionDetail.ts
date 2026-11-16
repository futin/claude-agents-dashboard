/**
 * sessionDetail.ts — the subagent-detail poll's accept/keep rule, apart from React so `test/sessions/session-detail-poll.test.ts` can drive it.
 */
import type { SessionDetail } from '../../../shared/types';

/** What `useSessionDetail` holds: the last good snapshot, and whether the id's first answer failed with none to keep. */
export interface DetailState {
  detail: SessionDetail | null;
  failed: boolean;
}

export const EMPTY_DETAIL: DetailState = { detail: null, failed: false };

function isGood(ok: boolean, body: unknown): body is SessionDetail {
  if (!ok || !body || typeof body !== 'object') return false;
  const b = body as Partial<SessionDetail>;
  return b.error !== true && Array.isArray(b.agents);
}

/**
 * The state after one poll answer. A good one replaces the snapshot. Anything else — a non-2xx status, the server's `{ error: true }` body, an unreadable
 * one, a fetch that never answered (`ok` false, `body` null) — keeps the last good snapshot, returned as the same object so React re-renders nothing, and
 * reads as failed only while there is no snapshot to keep.
 */
export function nextDetail(prev: DetailState, ok: boolean, body: unknown): DetailState {
  if (isGood(ok, body)) return { detail: body, failed: false };
  return prev.detail ? prev : { detail: null, failed: true };
}
