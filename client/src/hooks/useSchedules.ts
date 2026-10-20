import { useCallback, useEffect, useRef, useState } from 'react';

import type { SchedulesResponse } from '../../../shared/types';
import { useSettings } from './useSettings';

export interface SchedulesState {
  /** The last good payload; kept through a later failure. */
  data: SchedulesResponse | null;
  /** The latest fetch failed. With `data` null this is the page-level "Couldn't load". */
  error: boolean;
  /** Poll now — what a write (toggle, Run now, Save) calls so its effect shows before the next tick. */
  refresh(): void;
}

/**
 * `GET /api/schedules` for Management › Schedules, on the interval the Settings page sets (3s by default) like `useSessions`: a running job's `running ·
 * n of N` pill moves with the poll, and the page is the only mounted consumer, so leaving it stops the timer. A tick that lands while the tab is hidden is
 * skipped, and returning to the tab polls at once.
 */
export function useSchedules(): SchedulesState {
  const { settings } = useSettings();
  const { refreshMs } = settings;
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState(false);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    const poll = () => {
      fetch('/api/schedules')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<SchedulesResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.jobs)) throw new Error('bad payload');
          if (!alive) return;
          setData(body);
          setError(false);
        })
        .catch(() => { if (alive) setError(true); });
    };
    const tick = () => { if (document.visibilityState === 'visible') poll(); };
    pollRef.current = poll;
    poll();
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
