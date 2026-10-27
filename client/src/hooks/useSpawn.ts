import { useCallback, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { postWrite, replyError } from '../lib/postWrite';
import { READ_ONLY_TEXT } from '../lib/writeRefusal';
import type { SpawnRequest, SpawnResponse } from '../../../shared/types';

export interface SpawnControl {
  /** POSTs `req` to `/api/spawn`. Resolves the new session id on success, `null` otherwise — never throws. */
  launch: (req: SpawnRequest) => Promise<string | null>;
  pending: boolean;
  /** A reason to show the user — a validation error from the server, or a network failure. Cleared on the next attempt. */
  error: string | null;
  /** Set when the server refused the token — same meaning as useRemoteAnswer's flag. */
  needsToken: boolean;
  /** Set when the server says this network is read-only; `error` then carries `READ_ONLY_TEXT`. */
  readOnly: boolean;
  /**
   * Saves a freshly-entered token into the page's one shared copy (`useAnswerToken`), so a retry right after saving actually sends it, and so does every
   * other hook mounted beside this one.
   */
  setToken: (t: string) => void;
}

/**
 * Starts a new headless `claude -p` session: `POST /api/spawn`, with the same
 * Bearer-token pattern as `useRemoteAnswer`'s `toggle` — the shared `useAnswerToken`
 * copy, and a `403 → needsToken` branch. Unlike `toggle`, a failed
 * launch has a reason worth showing (unknown project, empty prompt, spawn
 * unavailable, …), so every other non-2xx status feeds `error` from the
 * server's JSON body instead of being silently ignored.
 */
export function useSpawn(): SpawnControl {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [token, setToken] = useAnswerToken();

  const launch = useCallback(async (req: SpawnRequest): Promise<string | null> => {
    if (pending) return null;
    setPending(true);
    setError(null);
    try {
      const result = await postWrite('/api/spawn', { token, body: req });
      if (result.status === 0) {
        setError('Could not reach the server.');
        return null;
      }
      if (result.refusal) {
        const readOnlyNow = result.refusal === 'read-only';
        setReadOnly(readOnlyNow);
        setNeedsToken(!readOnlyNow);
        if (readOnlyNow) setError(READ_ONLY_TEXT);
        return null;
      }
      setNeedsToken(false);
      setReadOnly(false);
      if (result.ok) return (result.body as SpawnResponse | undefined)?.sessionId ?? null;
      setError(replyError(result.body) ?? `Launch failed (${result.status}).`);
      return null;
    } finally {
      setPending(false);
    }
  }, [pending, token]);

  return { launch, pending, error, needsToken, readOnly, setToken };
}
