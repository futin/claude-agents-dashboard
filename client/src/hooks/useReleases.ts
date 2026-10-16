import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReleasesResponse } from '../../../shared/types';

/**
 * `/api/releases` — the version chip's and the What's new drawer's one data source. Fetched once on load and again by `refresh()` each time the drawer
 * opens; there is no poll, because a new version only appears after a pull or a tag, and the server memoises the read on exactly those.
 *
 * A failed fetch keeps the last good body, as `useAccount` does: the endpoint never answers an error, so a thrown fetch means the server is gone, which
 * says nothing about the releases.
 */
export function useReleases(): { data: ReleasesResponse | null; refresh: () => void } {
  const [data, setData] = useState<ReleasesResponse | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch('/api/releases');
        const body = await res.json() as ReleasesResponse;
        if (alive.current && body && Array.isArray(body.releases)) setData(body);
      } catch {
        /* keep what is on screen */
      }
    })();
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  return { data, refresh };
}
