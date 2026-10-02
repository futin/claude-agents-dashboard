import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchFailureOf } from '../lib/gitClock';
import { usePersistedState } from './usePersistedState';

export interface GitFetchControl {
  /** Fetch all now: `POST /api/git-fetch`. A no-op while this tab's own POST is out, and while a token the server wants is not stored. */
  start(): void;
  /** This tab's own POST is out; a fetch another tab or the timer started is the payload's `runningSinceMs`, not this. */
  pending: boolean;
  /** Why the last press launched nothing: the server refused the token, or the request failed any other way. Null after a success. */
  failure: 'refused' | 'failed' | null;
  /** An Answer token is stored on this device (the `dashboard.answerToken` key `useSpawn` and `useRemoteAnswer` share). */
  tokenStored: boolean;
}

/**
 * Management › Git's Fetch all key (git-fetch spec §4). `onDone` is the stats poll, run after every answer — a refusal included, so the chip re-reads the
 * clock either way. The POST answers once the fetch has been *started*, not finished: the fetch's own end is seen by the polls that follow.
 */
export function useGitFetch(tokenRequired: boolean | undefined, onDone: () => void): GitFetchControl {
  const [token] = usePersistedState<string>('dashboard.answerToken', '');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<'refused' | 'failed' | null>(null);
  const pendingRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const tokenStored = token !== '';

  // A refusal is about the token that was sent; a different one has not been refused.
  useEffect(() => setFailure(f => (f === 'refused' ? null : f)), [token]);

  const start = useCallback((): void => {
    if (pendingRef.current || (tokenRequired === true && !tokenStored)) return;
    pendingRef.current = true;
    setPending(true);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch('/api/git-fetch', { method: 'POST', headers })
      .then(res => setFailure(res.ok ? null : fetchFailureOf(res.status)), () => setFailure(fetchFailureOf('network')))
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
        onDoneRef.current();
      });
  }, [tokenRequired, tokenStored, token]);

  return { start, pending, failure, tokenStored };
}
