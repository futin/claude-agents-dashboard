import { useCallback, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { postWrite, replyError } from '../lib/postWrite';
import { READ_ONLY_TEXT } from '../lib/writeRefusal';

export interface StopControl {
  /**
   * `POST /api/sessions/:id/stop`. Resolves true when the server accepted the
   * stop (graceful or forced), false otherwise — never throws.
   */
  stop: (sessionId: string, force?: boolean) => Promise<boolean>;
  pending: boolean;
  /** A reason to show the user — the server's own message, or a network failure. Cleared on the next attempt. */
  error: string | null;
  /** Set when the server refused the token — same meaning as `useSpawn`'s flag. */
  needsToken: boolean;
}

/**
 * Stops a session this dashboard spawned, with the same Bearer-token pattern as
 * {@link useSpawn}: the page's one shared `useAnswerToken` copy, so a token saved
 * in any other panel is sent here without a remount, and a `403 → needsToken` branch.
 *
 * Every other non-2xx feeds `error` from the server's JSON body, because a
 * refused stop has a reason worth showing: a 404 here means the server no longer
 * holds a handle for that id (it already exited, or the dashboard restarted),
 * which is a different thing from the request having failed.
 */
export function useStopSession(): StopControl {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [token] = useAnswerToken();

  const stop = useCallback(async (sessionId: string, force = false): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      const result = await postWrite(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { token, body: { force } });
      if (result.status === 0) {
        setError('Could not reach the server.');
        return false;
      }
      if (result.refusal) {
        const readOnlyNow = result.refusal === 'read-only';
        setNeedsToken(!readOnlyNow);
        if (readOnlyNow) setError(READ_ONLY_TEXT);
        return false;
      }
      setNeedsToken(false);
      if (result.ok) return true;
      setError(replyError(result.body) ?? `Stop failed (${result.status}).`);
      return false;
    } finally {
      setPending(false);
    }
  }, [pending, token]);

  return { stop, pending, error, needsToken };
}
