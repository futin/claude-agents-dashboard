import { useEffect, useState } from 'react';

import type { UsageRatesResponse } from '../../../shared/types';

/**
 * What a percent of the 5-hour window costs in tokens, per model.
 *
 * One fetch per mount, unpolled — the same reasoning as `useUsageProfile`, and
 * a stronger case for it: the baseline is a 14-day window, so nothing here can
 * move within a session. Reopening the tab is how you pick up a new fit.
 *
 * A failed fetch keeps whatever was already on screen. The endpoint fails open
 * to an honest empty body, so a *thrown* fetch means the server is gone — and
 * blanking a card the reader was looking at would say something false about the
 * account rather than about the connection.
 */

export interface UsageRatesState {
  rates: UsageRatesResponse | null;
  loading: boolean;
  error: boolean;
}

export function useUsageRates(): UsageRatesState {
  const [state, setState] = useState<UsageRatesState>({
    rates: null,
    loading: true,
    error: false
  });

  useEffect(() => {
    let alive = true;
    fetch('/api/usage/rates')
      .then(res => res.json() as Promise<UsageRatesResponse>)
      .then(rates => {
        const ok = rates != null && Array.isArray(rates.models);
        if (alive) setState({ rates: ok ? rates : null, loading: false, error: !ok });
      })
      .catch(() => {
        if (alive) setState(prev => ({ rates: prev.rates, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, []);

  return state;
}
