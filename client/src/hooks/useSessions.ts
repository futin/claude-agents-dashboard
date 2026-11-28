import { useEffect, useRef, useState } from 'react';

import { useSettings } from './useSettings';
import { createPollSeq, pollFetch } from '../lib/pollSeq';
import { acceptSessions } from '../lib/sessionsPoll';
import { scanQuery } from '../lib/settings';
import type { SessionsResponse } from '../../../shared/types';

export interface SessionsState {
  data: SessionsResponse | null;
  /** false once a poll has failed or outlasted `POLL_TIMEOUT_MS` (server stopped?). */
  connected: boolean;
  /**
   * true after an answer carrying `error` (the server is up but its scan threw), false after a good one. Not folded into `connected`: the server
   * answered, so "disconnected" would be wrong. A thrown fetch leaves it as it was.
   */
  scanFailed: boolean;
}

/**
 * Poll `/api/sessions` on the interval the Settings page sets (3s by default).
 * Returns the latest snapshot + link health.
 *
 * The row count, time windows and project filter ride along as query params rather than server
 * config, so they're per-device and take effect on the very next tick — see
 * `server/api.ts` `scanOverrides`.
 */
export function useSessions(opts: { enabled?: boolean; limit?: number; projects?: readonly string[] } = {}): SessionsState {
  const [state, setState] = useState<SessionsState>({ data: null, connected: true, scanFailed: false });
  const timer = useRef<ReturnType<typeof setInterval>>();
  const { settings } = useSettings();
  const query = scanQuery(settings, opts.limit, opts.projects);
  const { refreshMs } = settings;
  // Off = no fetch and no timer, and the last payload is dropped so a later start cannot show a stale one. SessionsView never passes it.
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, connected: true, scanFailed: false });
      return;
    }
    let alive = true;
    // A tick while a scan is still out is skipped, so a slow answer can never land after a newer one and step the board backwards.
    const seq = createPollSeq();

    async function poll() {
      const n = seq.next(false);
      if (n === null) return;
      try {
        const res = await pollFetch(`/api/sessions${query}`);
        const data: SessionsResponse = await res.json();
        // A failed scan keeps the last good rows (`acceptSessions`), so the board never redraws as empty while the link still reads live.
        if (seq.settle(n) && alive) setState(prev => ({ data: acceptSessions(prev.data, data), connected: true, scanFailed: !!data.error }));
      } catch {
        if (seq.settle(n) && alive) setState(prev => ({ ...prev, connected: false }));
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
  }, [query, refreshMs, enabled]);

  return state;
}
