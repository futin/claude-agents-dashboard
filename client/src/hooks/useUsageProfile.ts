import { useEffect, useState } from 'react';

import type { UsageProfileResponse } from '../../../shared/types';

/**
 * The learned duty-cycle profile behind the weekly forecast.
 *
 * One fetch per mount, unpolled — same reasoning as `useGuides`: a bucket's
 * weight only moves when its week folds, so this data changes on a *weekly*
 * cadence. A 3s poll would be absurd; reopening the tab is how you pick up a
 * newly folded week.
 */

export interface UsageProfileState {
  profile: UsageProfileResponse | null;
  loading: boolean;
  error: boolean;
}

export function useUsageProfile(): UsageProfileState {
  const [state, setState] = useState<UsageProfileState>({
    profile: null,
    loading: true,
    error: false
  });

  useEffect(() => {
    let alive = true;
    fetch('/api/usage/profile')
      .then(res => res.json() as Promise<UsageProfileResponse>)
      .then(profile => {
        // A short cell array would render a torn grid, so treat it as an error
        // rather than drawing part of a week.
        const ok = Array.isArray(profile?.cells) && profile.cells.length === 168;
        if (alive) setState({ profile: ok ? profile : null, loading: false, error: !ok });
      })
      .catch(() => {
        if (alive) setState(prev => ({ profile: prev.profile, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, []);

  return state;
}
