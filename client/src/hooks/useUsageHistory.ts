import { useEffect, useState } from 'react';

import type { UsageHistoryResponse } from '../../../shared/types';

/**
 * Recorded 5-hour and weekly utilization over the last `days` days.
 *
 * Unpolled like `useUsageRates`: fetched on mount and whenever `days` changes. A thrown fetch keeps the previous body — the endpoint fails open, so a
 * throw means the server is gone, which says nothing about the account. The per-effect `alive` guard stops a slow 90-day answer from overwriting a
 * newer 7-day one.
 */

export interface UsageHistoryState {
  history: UsageHistoryResponse | null;
  loading: boolean;
  error: boolean;
}

export function useUsageHistory(days: number): UsageHistoryState {
  const [state, setState] = useState<UsageHistoryState>({ history: null, loading: true, error: false });

  useEffect(() => {
    let alive = true;
    setState(prev => ({ ...prev, loading: true }));
    fetch(`/api/usage/history?days=${days}`)
      .then(res => res.json() as Promise<UsageHistoryResponse>)
      .then(history => {
        const ok = history != null && Array.isArray(history.fiveHour) && Array.isArray(history.gaps);
        if (alive) setState({ history: ok ? history : null, loading: false, error: !ok });
      })
      .catch(() => {
        if (alive) setState(prev => ({ history: prev.history, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, [days]);

  return state;
}
