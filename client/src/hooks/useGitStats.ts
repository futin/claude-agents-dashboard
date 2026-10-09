import { useCallback, useEffect, useRef, useState } from 'react';

import type { GitStatsResponse } from '../../../shared/types';
import { createPollGate, skewOf } from '../lib/gitClock';
import { startGitPoll } from '../lib/gitPoll';

export interface GitStatsState {
  /** The last good payload; kept through a later failure (spec §6 copy table, last row). */
  data: GitStatsResponse | null;
  /** The latest fetch failed. With `data` null this is the page-level "Couldn't load"; with data, the chip's SYNC `failed`. */
  error: boolean;
  /** Client clock at the last good answer. */
  updatedAt: number | null;
  /** Poll now (the chip's Local sync key, and what a finished fetch or sync calls). Asked mid-poll, it queues exactly one more. */
  refresh(): void;
  /** Client clock of the next timed poll; null while the page is hidden (no timer) or before the first one is armed. */
  nextPollAtMs: number | null;
  /** A request is out. */
  polling: boolean;
  /** The client clock's lead over the server's at the last good answer (0 until one arrives); a server-stamped time plus this is that time on the client's clock. */
  skewMs: number;
}

/**
 * `GET /api/git-stats` for the Management › Git sub-view. Mounted only while that sub-view is, so switching to Projects or leaving the section stops it. The
 * schedule — on mount, every 30s while the page is visible, at once on becoming visible — is `startGitPoll`'s, tested apart from the DOM; the in-flight
 * bookkeeping is `createPollGate`'s: a poll asked for during another runs once after it, because the one in flight may predate what the caller just did.
 */
export function useGitStats(): GitStatsState {
  const [data, setData] = useState<GitStatsResponse | null>(null);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nextPollAtMs, setNextPollAtMs] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const [skewMs, setSkewMs] = useState(0);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const gate = createPollGate();
    const run = () => {
      setPolling(true);
      fetch('/api/git-stats')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<GitStatsResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.repos)) throw new Error('bad payload');
          if (!alive) return;
          const receipt = Date.now();
          setData(body);
          setError(false);
          setUpdatedAt(receipt);
          setSkewMs(skewOf(body.generatedAt, receipt));
        })
        .catch(() => { if (alive) setError(true); })
        .finally(() => {
          const again = gate.end();
          if (!alive) return;
          if (again) run();
          else setPolling(false);
        });
    };
    const request = () => { if (gate.request() === 'run') run(); };
    pollRef.current = request;
    const stop = startGitPoll({
      poll: request,
      isVisible: () => document.visibilityState === 'visible',
      onVisibilityChange: cb => {
        document.addEventListener('visibilitychange', cb);
        return () => document.removeEventListener('visibilitychange', cb);
      },
      setTimer: (fn, ms) => window.setInterval(fn, ms),
      clearTimer: id => window.clearInterval(id as number),
      onSchedule: setNextPollAtMs,
    });
    return () => {
      alive = false;
      pollRef.current = () => {};
      stop();
    };
  }, []);

  const refresh = useCallback(() => pollRef.current(), []);
  return { data, error, updatedAt, refresh, nextPollAtMs, polling, skewMs };
}
