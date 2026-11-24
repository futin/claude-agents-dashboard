import { useEffect, useState } from 'react';

import { createPollSeq, pollFetch } from '../lib/pollSeq';
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
 *
 * Follows the `pollSeq` rule: a tick is skipped while a request is out, and only the newest answer is applied.
 */
export const ACCOUNT_POLL_MS = 30_000;

export function useAccount(): AccountResponse | null {
  const [data, setData] = useState<AccountResponse | null>(null);

  useEffect(() => {
    let alive = true;
    // The default 30s bound equals the interval, so a hung request costs one skipped tick at most.
    const seq = createPollSeq();

    async function poll(): Promise<void> {
      const n = seq.next(false);
      if (n === null) return;
      try {
        const res = await pollFetch('/api/account');
        const body = await res.json() as AccountResponse;
        if (seq.settle(n) && alive && body && typeof body === 'object') setData(body);
      } catch {
        seq.settle(n); // keep what is on screen
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
