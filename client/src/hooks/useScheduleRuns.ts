import { useCallback, useEffect, useRef, useState } from 'react';

import type { ScheduleRunsResponse } from '../../../shared/types';
import { createPollSeq, runsQueryString, type ScheduleRunsQuery } from '../lib/schedules';
import { useSettings } from './useSettings';

export interface ScheduleRunsState {
  /** The last good payload for the current filters; kept through a later failure, and null while a changed filter has no answer yet so a stale list never shows under new ones. */
  data: ScheduleRunsResponse | null;
  error: boolean;
  refresh(): void;
}

/**
 * `GET /api/schedules/runs` for the Runs screen and a row's fold (`days` + `job`), polled like `useSchedules` (same gate: a tick is skipped while a fetch is
 * out, `refresh()` supersedes). `enabled: false` — the Jobs page is showing and nothing reads the list — stops the timer and hides the payload, so the server
 * does not fold the whole log every 3s for a screen nobody is on.
 */
export function useScheduleRuns(q: ScheduleRunsQuery, enabled = true): ScheduleRunsState {
  const { settings } = useSettings();
  const { refreshMs } = settings;
  const query = runsQueryString(q);
  // Keyed by the query it answers, so the render after a filter change already reads null instead of the old filter's list for one frame.
  const [got, setGot] = useState<{ query: string; body: ScheduleRunsResponse } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const seq = createPollSeq();
    const poll = (force: boolean) => {
      const mine = seq.next(force);
      if (mine === null) return;
      fetch(`/api/schedules/runs${query}`)
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<ScheduleRunsResponse>;
        })
        .then(body => {
          if (!body || !Array.isArray(body.runs)) throw new Error('bad payload');
          if (alive && seq.settle(mine)) { setGot({ query, body }); setFailed(null); }
        })
        .catch(() => { if (alive && seq.settle(mine)) setFailed(query); });
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
  }, [query, refreshMs, enabled]);

  const refresh = useCallback(() => pollRef.current(), []);
  return { data: enabled && got?.query === query ? got.body : null, error: enabled && failed === query, refresh };
}
