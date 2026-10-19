import { useCallback, useEffect, useRef, useState } from 'react';

import type { CodegraphResponse } from '../../../shared/types';
import { CODEGRAPH_FAST_POLL_MS, hasLiveRun } from '../lib/codegraphPoll';
import { createPollGate } from '../lib/gitClock';
import { startGitPoll } from '../lib/gitPoll';

export interface CodegraphState {
  /** The last good payload; kept through a later failure. */
  data: CodegraphResponse | null;
  /** The latest fetch failed. With `data` null this is the page-level "Couldn't load". */
  error: boolean;
  /** Client clock at the last good answer. */
  updatedAt: number | null;
  /** Re-read status: poll now with `?fresh=1`, so the server asks the CLI instead of answering from its cache. Asked mid-poll, the queued poll is the fresh one. */
  refresh(): void;
  /** Poll now from the cache (what a Sync / Reindex answer calls). Asked mid-poll, it queues exactly one more. */
  poll(): void;
  /** Client clock of the next timed poll; null while the page is hidden (no timer) or before the first one is armed. */
  nextPollAtMs: number | null;
  /** A request is out. */
  polling: boolean;
}

/**
 * `GET /api/codegraph` for the Management › CodeGraph sub-view, on `useGitStats`'s schedule (`startGitPoll`, `createPollGate`). On top of it, a payload
 * with a run in it arms one refresh `CODEGRAPH_FAST_POLL_MS` later; that timer is a single slot, replaced by every payload and cleared on unmount, so
 * it never stacks however many answers arrive. Only `refresh()` sends `fresh=1`; the timed poll, the fast re-poll and `poll()` never do, since a fresh read
 * runs the CLI for every indexed pin.
 */
export function useCodegraph(): CodegraphState {
  const [data, setData] = useState<CodegraphResponse | null>(null);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nextPollAtMs, setNextPollAtMs] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<() => void>(() => {});
  const rereadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let fast: number | null = null;
    // Set by `refresh()`, taken by the next fetch that goes out — the queued one when a poll is already in flight.
    let freshNext = false;
    const gate = createPollGate();
    const clearFast = () => {
      if (fast !== null) window.clearTimeout(fast);
      fast = null;
    };
    const run = () => {
      setPolling(true);
      const url = freshNext ? '/api/codegraph?fresh=1' : '/api/codegraph';
      freshNext = false;
      fetch(url)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<CodegraphResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.repos)) throw new Error('bad payload');
          if (!alive) return;
          setData(body);
          setError(false);
          setUpdatedAt(Date.now());
          clearFast();
          if (hasLiveRun(body)) fast = window.setTimeout(() => { fast = null; request(); }, CODEGRAPH_FAST_POLL_MS);
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
    rereadRef.current = () => { freshNext = true; request(); };
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
      rereadRef.current = () => {};
      clearFast();
      stop();
    };
  }, []);

  const refresh = useCallback(() => rereadRef.current(), []);
  const poll = useCallback(() => pollRef.current(), []);
  return { data, error, updatedAt, refresh, poll, nextPollAtMs, polling };
}
