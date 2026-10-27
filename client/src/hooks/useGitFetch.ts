import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchFailureOf } from '../lib/gitClock';
import type { FetchFailure } from '../lib/gitClock';
import type { WriteAccess } from '../../../shared/types';
import { useAnswerToken } from './useAnswerToken';
import { postWrite } from '../lib/postWrite';

export interface GitFetchControl {
  /** Fetch all now: `POST /api/git-fetch`. A no-op while this tab's own POST is out, while a token the server wants is not stored, and on a read-only network. */
  start(): void;
  /** This tab's own POST is out; a fetch another tab or the timer started is the payload's `runningSinceMs`, not this. */
  pending: boolean;
  /** Why the last press launched nothing: the server refused the token, said this network is read-only, or the request failed any other way. Null after a success. */
  failure: FetchFailure | null;
  /** An Answer token is stored on this device (the `dashboard.answerToken` key `useSpawn` and `useRemoteAnswer` share). */
  tokenStored: boolean;
}

/**
 * Management › Git's Fetch all key (git-fetch spec §4). `onDone` is the stats poll, run after every answer — a refusal included, so the chip re-reads the
 * clock either way. The POST answers once the fetch has *finished* (the server awaits `fetchAll`), so the poll after it already sees the new refs.
 */
export function useGitFetch(tokenRequired: boolean | undefined, writeAccess: WriteAccess | undefined, onDone: () => void): GitFetchControl {
  const [token] = useAnswerToken();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
  const pendingRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const tokenStored = token !== '';

  // A refusal is about the token that was sent; a different one has not been refused.
  useEffect(() => setFailure(f => (f === 'refused' ? null : f)), [token]);

  const start = useCallback((): void => {
    if (pendingRef.current || writeAccess === 'none' || (tokenRequired === true && !tokenStored)) return;
    pendingRef.current = true;
    setPending(true);
    postWrite('/api/git-fetch', { token })
      .then(result => setFailure(result.ok ? null : fetchFailureOf(result.status === 0 ? 'network' : result.status, result.body)))
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
        onDoneRef.current();
      });
  }, [tokenRequired, writeAccess, tokenStored, token]);

  return { start, pending, failure, tokenStored };
}
