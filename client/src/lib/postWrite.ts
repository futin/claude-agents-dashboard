/**
 * postWrite.ts — the one way a client hook sends a write and reads its 403. Apart from React so a node test can drive it with a stub `fetch`.
 *
 * Every write hook used to copy the same block: send with the Answer token, then on a 403 re-read the body and ask `refusalKind` which refusal it was. Here
 * the reply is read once, for every status, and the refusal is classified from that one read.
 */

import { authHeaders } from './answerToken';
import { refusalKind } from './writeRefusal';

export interface WriteResult {
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  ok: boolean;
  /** Which kind of 403 this was (`refusalKind`); null for any other status. */
  refusal: 'token' | 'read-only' | null;
  /** The parsed reply, or `undefined` when there was none or it was not JSON. */
  body: unknown;
}

export interface WriteOptions {
  token: string;
  /** Sent as JSON with a `Content-Type` header; left out, the request has neither. */
  body?: unknown;
  method?: string;
  fetchImpl?: typeof fetch;
}

/** Sends one write with the Answer token. Never throws: a network failure is `{ status: 0, ok: false, refusal: null, body: undefined }`. */
export async function postWrite(url: string, { token, body, method = 'POST', fetchImpl = fetch }: WriteOptions): Promise<WriteResult> {
  const init: RequestInit = body === undefined
    ? { method, headers: authHeaders(token) }
    : { method, headers: authHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) };
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return { status: 0, ok: false, refusal: null, body: undefined };
  }
  const reply: unknown = await res.json().catch(() => undefined);
  return { status: res.status, ok: res.ok, refusal: refusalKind(res.status, reply), body: reply };
}

/** The server's `{ error }` text from a reply body, if it carried one. */
export function replyError(body: unknown): string | undefined {
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof error === 'string' ? error : undefined;
}
