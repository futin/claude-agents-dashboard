import type { Session, SessionsResponse } from '../../../shared/types';

/**
 * What the Sessions chat drawer does about a `chatId` the poll may not carry (#421).
 *
 * The poll is project-filtered server-side, so a deep-linked or just-launched session in a filtered-out project never shows up in `data.sessions`;
 * the drawer then falls back to a row fetched from `GET /api/sessions/:id/row`, the way Routines opens its drawer.
 *
 * Without `status` this asks whether to fetch: `fetch` when a payload has arrived, it lacks `chatId`, and no fetched row for `chatId` is held;
 * otherwise `none`. With `status` — a failed fetch's HTTP status, or `'error'` for a thrown one — it judges the answer: a `404` for an id not in
 * `data.launching` means the session does not exist, so `clear` disarms `chatId`; a `404` for a launch whose transcript is not on disk yet, and any
 * other failure, is `keep`, and the next payload retries.
 */
export type ChatRowAction = 'none' | 'fetch' | 'keep' | 'clear';

export function chatRowAction(input: {
  chatId: string | null;
  data: Pick<SessionsResponse, 'sessions' | 'launching'> | null;
  fetchedId: string | null;
  status?: number | 'error';
}): ChatRowAction {
  const { chatId, data, fetchedId, status } = input;
  if (status !== undefined) {
    if (status !== 404) return 'keep';
    return (data?.launching ?? []).some(l => l.sessionId === chatId) ? 'keep' : 'clear';
  }
  if (!chatId || !data) return 'none';
  if (data.sessions.some(s => s.id === chatId)) return 'none';
  return fetchedId === chatId ? 'none' : 'fetch';
}

/**
 * The drawer's session: the live poll row when the poll carries `chatId`, so status and context keep updating, else the fetched row when it is for
 * `chatId` — a snapshot, the same trade Routines makes — else none. A fetched row is never shown under another id.
 */
export function chatDrawerSession(
  chatId: string | null,
  data: Pick<SessionsResponse, 'sessions'> | null,
  fetched: Session | null
): Session | null {
  if (!chatId || !data) return null;
  return data.sessions.find(s => s.id === chatId) ?? (fetched?.id === chatId ? fetched : null);
}
