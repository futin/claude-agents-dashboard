import { useEffect, useState } from 'react';

import type { AccountResponse } from '../../../shared/types';

/**
 * Poll `/api/account` — the header chip's whole data source.
 *
 * 30s, not the 3s of `useSessions`: the body is a memoised file read plus the
 * server's 60s usage cache, so a faster poll would return the same numbers.
 * Owned by `App` and passed down, because the chip is drawn in the desktop
 * header band *or* the phone nav bar and both must not poll at once.
 *
 * A failed poll keeps the last good snapshot rather than blanking the chip: the
 * endpoint fails open, so a *thrown* fetch means the server is gone, which is
 * not a statement about the account. `useSessions` already owns saying the link
 * is down.
 */
export const ACCOUNT_POLL_MS = 30_000;

export function useAccount(): AccountResponse | null {
  const [data, setData] = useState<AccountResponse | null>(null);

  useEffect(() => {
    let alive = true;

    async function poll(): Promise<void> {
      try {
        const res = await fetch('/api/account');
        const body = await res.json() as AccountResponse;
        if (alive && body && typeof body === 'object') setData(body);
      } catch {
        /* keep what is on screen */
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), ACCOUNT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return data;
}
