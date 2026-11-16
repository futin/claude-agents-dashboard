/**
 * pushTest.ts — the line Settings › Shared's "send test push" leaves, from its `postWrite` result. Apart from React so a test can pin every case (#436).
 *
 * The write goes through `postWrite` like every other write, so a 403 reads as the shared refusal text, never the server's raw `error`, and a reply that
 * was not JSON (a proxy's HTML 502) still reads as an answer: `postWrite` reports `status: 0` only when nothing answered at all.
 */
import { replyError, type WriteResult } from './postWrite';
import { READ_ONLY_TEXT } from './writeRefusal';
import type { NotifyTestResponse } from '../../../shared/types';

/** The token hint, in the same shape as `FETCH_NEEDS_TOKEN` and `SYNC_NEEDS_TOKEN`. */
export const PUSH_TEST_NEEDS_TOKEN = 'Test push needs the Answer token — set it under Settings › Local › Connection.';

export function pushTestText(result: WriteResult): string {
  if (result.refusal === 'read-only') return READ_ONLY_TEXT;
  if (result.refusal === 'token') return PUSH_TEST_NEEDS_TOKEN;
  if (result.status === 0) return 'the dashboard did not answer';
  const body = result.body;
  const outcome = body !== null && typeof body === 'object' ? (body as Partial<Record<keyof NotifyTestResponse, unknown>>).outcome : undefined;
  if (typeof outcome === 'string') return outcome;
  const error = replyError(body);
  return `the dashboard answered ${result.status}${error === undefined ? '' : `: ${error}`}`;
}
