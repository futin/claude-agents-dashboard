import { useEffect, useState } from 'react';

import type { GuidesIndex } from '../../../shared/types';

/**
 * Guides data hook. No polling, no refresh key: unlike sessions' 3s poll,
 * published guides change on the order of days, so one fetch per mount is
 * enough — reopening the tab (a fresh mount) is how you pick up a new deck.
 */

export interface GuidesState {
  index: GuidesIndex | null;
  loading: boolean;
  error: boolean;
}

export function useGuides(): GuidesState {
  const [state, setState] = useState<GuidesState>({ index: null, loading: true, error: false });

  useEffect(() => {
    let alive = true;
    fetch('/api/guides')
      .then(res => res.json() as Promise<GuidesIndex>)
      .then(index => {
        if (alive) setState({ index, loading: false, error: index.error === true });
      })
      .catch(() => {
        if (alive) setState(prev => ({ index: prev.index, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, []);

  return state;
}
