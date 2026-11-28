import { useEffect, useState } from 'react';

import { usableRates } from '../lib/usageBody';
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
        // An `error: true` body is the route's fail-open catch, not "recording off" — it reads as could-not-be-read, like a thrown fetch.
        const ok = usableRates(rates);
        if (alive) setState({ rates: ok, loading: false, error: ok === null });
      })
      .catch(() => {
        if (alive) setState(prev => ({ rates: prev.rates, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, []);

  return state;
}
