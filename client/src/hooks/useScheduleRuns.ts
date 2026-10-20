import { useCallback, useEffect, useRef, useState } from 'react';

import type { ScheduleRunsResponse } from '../../../shared/types';
import { runsQueryString, type ScheduleRunsQuery } from '../lib/schedules';
import { useSettings } from './useSettings';

export interface ScheduleRunsState {
  /** The last good payload for the current filters; kept through a later failure, dropped when a filter changes so a stale list is never shown under new ones. */
  data: ScheduleRunsResponse | null;
  error: boolean;
  refresh(): void;
}

/**
 * `GET /api/schedules/runs` for the Runs screen and a row's fold (`days` + `job`), polled like `useSchedules`. `enabled: false` — the Jobs page is showing and
 * nothing reads the list — drops the payload and the timer, so the server does not fold the whole log every 3s for a screen nobody is on.
 */
export function useScheduleRuns(q: ScheduleRunsQuery, enabled = true): ScheduleRunsState {
  const { settings } = useSettings();
  const { refreshMs } = settings;
  const query = runsQueryString(q);
  const [data, setData] = useState<ScheduleRunsResponse | null>(null);
  const [error, setError] = useState(false);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    setData(null);
    setError(false);
    if (!enabled) return;
    let alive = true;
    const poll = () => {
      fetch(`/api/schedules/runs${query}`)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<ScheduleRunsResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.runs)) throw new Error('bad payload');
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
  }, [query, refreshMs, enabled]);

  const refresh = useCallback(() => pollRef.current(), []);
  return { data, error, refresh };
}
