import { useCallback, useEffect, useRef, useState } from 'react';

import type { RoutinesResponse } from '../../../shared/types';
import { createPollSeq } from '../lib/routines';
import { useSettings } from './useSettings';

export interface RoutinesState {
  /** The last good payload; kept through a later failure. */
  data: RoutinesResponse | null;
  /** The latest fetch failed. With `data` null this is the page-level "Couldn't load". */
  error: boolean;
  /** Poll now — what a write (toggle, Run now, Save) calls so its effect shows before the next tick. */
  refresh(): void;
}

/**
 * `GET /api/routines` for the Routines section, on the interval the Settings page sets (3s by default) like `useSessions`: a running job's `running ·
 * n of N` pill moves with the poll, and the page is the only mounted consumer, so leaving it stops the timer. A tick that lands while the tab is hidden, or
 * while a fetch is still out, is skipped (`createPollSeq`), and returning to the tab polls at once; `refresh()` always fetches and supersedes one in flight.
 */
export function useRoutines(): RoutinesState {
  const { settings } = useSettings();
  const { refreshMs } = settings;
  const [data, setData] = useState<RoutinesResponse | null>(null);
  const [error, setError] = useState(false);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const seq = createPollSeq();
    const poll = (force: boolean) => {
      const mine = seq.next(force);
      if (mine === null) return;
      fetch('/api/routines')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<RoutinesResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.jobs)) throw new Error('bad payload');
          if (alive && seq.settle(mine)) { setData(body); setError(false); }
        })
        .catch(() => { if (alive && seq.settle(mine)) setError(true); });
    };
    const tick = () => { if (document.visibilityState === 'visible') poll(false); };
    pollRef.current = () => poll(true);
    poll(true);
    const timer = window.setInterval(tick, refreshMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      pollRef.current = () => {};
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refreshMs]);

  const refresh = useCallback(() => pollRef.current(), []);
  return { data, error, refresh };
}
