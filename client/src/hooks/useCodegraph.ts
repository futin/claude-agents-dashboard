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
  /** Poll now (Re-read status, and what a finished run calls). Asked mid-poll, it queues exactly one more. */
  refresh(): void;
  /** Client clock of the next timed poll; null while the page is hidden (no timer) or before the first one is armed. */
  nextPollAtMs: number | null;
  /** A request is out. */
  polling: boolean;
}

/**
 * `GET /api/codegraph` for the Management › CodeGraph sub-view, on `useGitStats`'s schedule (`startGitPoll`, `createPollGate`). On top of it, a payload
 * with a run in it arms one refresh `CODEGRAPH_FAST_POLL_MS` later; that timer is a single slot, replaced by every payload and cleared on unmount, so
 * it never stacks however many answers arrive.
 */
export function useCodegraph(): CodegraphState {
  const [data, setData] = useState<CodegraphResponse | null>(null);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nextPollAtMs, setNextPollAtMs] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let fast: number | null = null;
    const gate = createPollGate();
    const clearFast = () => {
      if (fast !== null) window.clearTimeout(fast);
      fast = null;
    };
    const run = () => {
      setPolling(true);
      fetch('/api/codegraph')
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
      clearFast();
      stop();
    };
  }, []);

  const refresh = useCallback(() => pollRef.current(), []);
  return { data, error, updatedAt, refresh, nextPollAtMs, polling };
}
