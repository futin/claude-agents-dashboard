import type { Session, SessionsResponse } from '../../../shared/types';

/**
 * What the Sessions chat drawer does about a `chatId` the poll may not carry (#421).
 *
 * The poll is project-filtered server-side, so a deep-linked or just-launched session in a filtered-out project never shows up in `data.sessions`;
 * the drawer then falls back to a row fetched from `GET /api/sessions/:id/row`, the way Routines opens its drawer.
 *
 * Without `status` this asks whether to fetch: `fetch` when a payload has arrived since `chatId` was armed (`fresh`), it lacks `chatId`, and no fetched
 * row for `chatId` is held; otherwise `none`. `fresh` is what keeps a launch armed: `onLaunched` sets `chatId` while the last payload still predates the
 * launch, so that payload's `launching` cannot list the id, and a `404` judged against it would disarm a launch whose transcript is simply not written
 * yet. The next payload lists it, and its `404` is `keep`. With `status` — a failed fetch's HTTP status, or `'error'` for a thrown one — it judges the answer: a `404` for an id not in
 * `data.launching` means the session does not exist, so `clear` disarms `chatId`; a `404` for a launch whose transcript is not on disk yet, and any
 * other failure, is `keep`, and the next payload retries.
 */
export type ChatRowAction = 'none' | 'fetch' | 'keep' | 'clear';

export function chatRowAction(input: {
  chatId: string | null;
  data: Pick<SessionsResponse, 'sessions' | 'launching'> | null;
  fetchedId: string | null;
  fresh: boolean;
  status?: number | 'error';
}): ChatRowAction {
  const { chatId, data, fetchedId, fresh, status } = input;
  if (status !== undefined) {
    if (status !== 404) return 'keep';
    return (data?.launching ?? []).some(l => l.sessionId === chatId) ? 'keep' : 'clear';
  }
  if (!chatId || !data || !fresh) return 'none';
  if (data.sessions.some(s => s.id === chatId)) return 'none';
  return fetchedId === chatId ? 'none' : 'fetch';
}

/**
 * The drawer's session: the live poll row when the poll carries `chatId`, so status and context keep updating, else the fetched row when it is for
 * `chatId` — a snapshot — else none. A fetched row is never shown under another id.
 */
export function chatDrawerSession(
  chatId: string | null,
  data: Pick<SessionsResponse, 'sessions'> | null,
  fetched: Session | null
): Session | null {
  if (!chatId || !data) return null;
  return data.sessions.find(s => s.id === chatId) ?? (fetched?.id === chatId ? fetched : null);
}

/**
 * A re-fetched `GET /api/sessions/:id/row` answer for the drawer Routines opens, which no sessions poll feeds: applied only when it is a row for `openId`
 * and the drawer still shows `openId`, so a late answer never swaps the session under it. A failed or malformed tick keeps the last row.
 */
export function nextSessionRow(prev: Session | null, openId: string, ok: boolean, body: unknown): Session | null {
  if (!ok || prev?.id !== openId || body === null || typeof body !== 'object' || (body as Partial<Session>).id !== openId) return prev;
  return body as Session;
}
