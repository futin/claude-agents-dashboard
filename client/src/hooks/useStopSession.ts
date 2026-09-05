import { useCallback, useState } from 'react';

import { usePersistedState } from './usePersistedState';

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
 * {@link useSpawn}: one shared `usePersistedState('dashboard.answerToken')` call
 * — not a second, independent one, which would not see a token saved elsewhere
 * until this hook's component remounted — and a `403 → needsToken` branch.
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
  const [token] = usePersistedState<string>('dashboard.answerToken', '');

  const stop = useCallback(async (sessionId: string, force = false): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setError(null);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: 'POST', headers, body: JSON.stringify({ force })
      });
      if (res.status === 403) {
        setNeedsToken(true);
        return false;
      }
      setNeedsToken(false);
      if (res.ok) return true;
      const body = await res.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? `Stop failed (${res.status}).`);
      return false;
    } catch {
      setError('Could not reach the server.');
      return false;
    } finally {
      setPending(false);
    }
  }, [pending, token]);

  return { stop, pending, error, needsToken };
}
