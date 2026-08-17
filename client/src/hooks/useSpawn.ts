import { useCallback, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import type { SpawnRequest } from '../../../shared/types';

export interface SpawnControl {
  /** POSTs `req` to `/api/spawn`. Resolves the new session id on success, `null` otherwise — never throws. */
  launch: (req: SpawnRequest) => Promise<string | null>;
  pending: boolean;
  /** A reason to show the user — a validation error from the server, or a network failure. Cleared on the next attempt. */
  error: string | null;
  /** Set when the server refused the token — same meaning as useRemoteAnswer's flag. */
  needsToken: boolean;
  /**
   * Saves a freshly-entered token. `launch` reads the very same persisted
   * state this setter writes (one `usePersistedState` call, shared), so a
   * retry right after saving actually sends it — the same "one dashboard, one
   * token" reasoning `usePendingMessage` documents. A second, independent
   * `usePersistedState('dashboard.answerToken', …)` call in the panel would
   * not see this write until the panel remounted.
   */
  setToken: (t: string) => void;
}

/**
 * Starts a new headless `claude -p` session: `POST /api/spawn`, with the same
 * Bearer-token pattern as `useRemoteAnswer`'s `toggle` — the `dashboard.answerToken`
 * persisted key, and a `403 → needsToken` branch. Unlike `toggle`, a failed
 * launch has a reason worth showing (unknown project, empty prompt, spawn
 * unavailable, …), so every other non-2xx status feeds `error` from the
 * server's JSON body instead of being silently ignored.
 */
export function useSpawn(): SpawnControl {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setToken] = usePersistedState<string>('dashboard.answerToken', '');

  const launch = useCallback(async (req: SpawnRequest): Promise<string | null> => {
    if (pending) return null;
    setPending(true);
    setError(null);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/spawn', {
        method: 'POST', headers, body: JSON.stringify(req)
      });
      if (res.status === 403) {
        setNeedsToken(true);
        return null;
      }
      setNeedsToken(false);
      if (res.ok) {
        const body = (await res.json()) as { sessionId: string };
        return body.sessionId;
      }
      const body = await res.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? `Launch failed (${res.status}).`);
      return null;
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setPending(false);
    }
  }, [pending, token]);

  return { launch, pending, error, needsToken, setToken };
}
