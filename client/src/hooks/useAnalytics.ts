import { useCallback, useEffect, useState } from 'react';

import type { AnalyticsResponse } from '../../../shared/types';

/**
 * Analytics data hook. Like the management hooks, it does NOT poll — the list is
 * driven by `/doctor` (which changes rarely), so it's fetched on mount and on
 * manual refresh only.
 */
export interface AnalyticsState {
  data: AnalyticsResponse | null;
  loading: boolean;
  error: boolean;
}

export function useAnalytics() {
  const [state, setState] = useState<AnalyticsState>({ data: null, loading: true, error: false });
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey(n => n + 1), []);

  useEffect(() => {
    let alive = true;
    setState(prev => ({ data: prev.data, loading: true, error: false }));
    fetch('/api/analytics')
      .then(res => res.json() as Promise<AnalyticsResponse>)
      .then(data => {
        if (alive) setState({ data, loading: false, error: data.error === true });
      })
      .catch(() => {
        if (alive) setState(prev => ({ data: prev.data, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, [refreshKey]);

  return { ...state, refresh };
}
