import { useEffect, useState } from 'react';

import type { UsageRatesResponse } from '../../../shared/types';

/**
 * What a percent of the 5-hour window costs in tokens, per model.
 *
 * One fetch per mount, unpolled, like `useUsageProfile` — the baseline is 14
 * days, so nothing here moves within a session. A failed fetch keeps what is
 * already on screen: the endpoint fails open, so a *thrown* fetch means the
 * server is gone, which is not a statement about the account.
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
