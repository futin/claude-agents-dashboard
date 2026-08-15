import { useEffect, useRef, useState } from 'react';

import { useSettings } from './useSettings';
import { scanQuery } from '../lib/settings';
import type { SessionsResponse } from '../../../shared/types';

export interface SessionsState {
  data: SessionsResponse | null;
  /** false once a poll has failed (server stopped?). */
  connected: boolean;
}

/**
 * Poll `/api/sessions` on the interval the Settings page sets (3s by default).
 * Returns the latest snapshot + link health.
 *
 * The row count and time windows ride along as query params rather than server
 * config, so they're per-device and take effect on the very next tick — see
 * `server/api.ts` `scanOverrides`.
 */
export function useSessions(): SessionsState {
  const [state, setState] = useState<SessionsState>({ data: null, connected: true });
  const timer = useRef<ReturnType<typeof setInterval>>();
  const { settings } = useSettings();
  const query = scanQuery(settings);
  const { refreshMs } = settings;

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch(`/api/sessions${query}`);
        const data: SessionsResponse = await res.json();
        if (alive) setState({ data, connected: true });
      } catch {
        if (alive) setState(prev => ({ data: prev.data, connected: false }));
      }
    }

    poll();
    timer.current = setInterval(poll, refreshMs);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
    // Changing either restarts the loop, so a new interval or row count shows up
    // immediately instead of on the next natural tick.
  }, [query, refreshMs]);

  return state;
}
