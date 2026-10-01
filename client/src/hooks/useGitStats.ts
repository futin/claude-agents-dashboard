import { useCallback, useEffect, useRef, useState } from 'react';

import type { GitStatsResponse } from '../../../shared/types';
import { startGitPoll } from '../lib/gitPoll';

export interface GitStatsState {
  /** The last good payload; kept through a later failure (spec §6 copy table, last row). */
  data: GitStatsResponse | null;
  /** The latest fetch failed. With `data` null this is the page-level "Couldn't load"; with data, the band's "couldn't update". */
  error: boolean;
  /** Client clock at the last good answer, for the band's "updated Ns ago". */
  updatedAt: number | null;
  /** Poll now (the band's ↻). A no-op while a poll is already in flight. */
  refresh(): void;
}

/**
 * `GET /api/git-stats` for the Management › Git sub-view. Mounted only while that sub-view is, so switching to Pinned or leaving the section stops it. The
 * schedule — on mount, every 30s while the page is visible, at once on becoming visible — is `startGitPoll`'s, tested apart from the DOM.
 */
export function useGitStats(): GitStatsState {
  const [data, setData] = useState<GitStatsResponse | null>(null);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let inflight = false;
    const poll = () => {
      if (inflight) return;
      inflight = true;
      fetch('/api/git-stats')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<GitStatsResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.repos)) throw new Error('bad payload');
          if (!alive) return;
          setData(body);
          setError(false);
          setUpdatedAt(Date.now());
        })
        .catch(() => { if (alive) setError(true); })
        .finally(() => { inflight = false; });
    };
    pollRef.current = poll;
    const stop = startGitPoll({
      poll,
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange: cb => {
        document.addEventListener('visibilitychange', cb);
        return () => document.removeEventListener('visibilitychange', cb);
      },
      setTimer: (fn, ms) => window.setInterval(fn, ms),
      clearTimer: id => window.clearInterval(id as number),
    });
    return () => {
      alive = false;
      pollRef.current = () => {};
      stop();
    };
  }, []);

  const refresh = useCallback(() => pollRef.current(), []);
  return { data, error, updatedAt, refresh };
}
