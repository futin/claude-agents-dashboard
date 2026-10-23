/**
 * The CodeGraph sub-view's poll and run rules, apart from React so `test/codegraph-client.test.ts` can drive them: when the page polls fast, and which
 * line a `POST /api/codegraph/run` answer leaves under the band.
 */
import type { CodegraphResponse, CodegraphRunKind } from '../../../shared/types';
import { CODEGRAPH_NEEDS_TOKEN, codegraphRunConflictText, codegraphRunFailedText, codegraphRunMissingText } from './codegraphText';
import { READ_ONLY_TEXT, refusalKind } from './writeRefusal';

/** How soon after a payload that still has a run in it the page asks again, so a finishing sync shows within a few seconds rather than at the 30s tick. */
export const CODEGRAPH_FAST_POLL_MS = 3000;

/** Any pinned repo has a run in flight, ours or a rebuild started from a terminal (the server synthesises `run` for the latter). */
export function hasLiveRun(data: CodegraphResponse | null): boolean {
  return data !== null && data.repos.some(r => r.run !== null);
}

/**
 * The note a run's answer leaves, or null when it started (200). A 403 is a token prompt unless it is the read-only refusal, or the server saying the
 * dirName is not a pin — no token fixes that one, so it reads as a failed start rather than sending the user to Settings.
 */
export function runNote(status: number, body: unknown, name: string, kind: CodegraphRunKind): string | null {
  if (status === 200) return null;
  if (status === 409) return codegraphRunConflictText(name);
  if (status === 404) return codegraphRunMissingText(name);
  if (status === 403) {
    const refusal = refusalKind(status, body);
    if (refusal === 'read-only') return READ_ONLY_TEXT;
    const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    return error === 'not a pinned project' ? codegraphRunFailedText(name, kind) : CODEGRAPH_NEEDS_TOKEN;
  }
  return codegraphRunFailedText(name, kind);
}
