import { useEffect, useState } from 'react';

import { createPollSeq, pollFetch } from '../lib/pollSeq';
import { acceptSpend } from '../lib/sessionSpend';
import { useSettings } from './useSettings';
import type { SessionSpend } from '../../../shared/types';

/**
 * Fetch `/api/sessions/:id/spend` while the session's drawer is open, polling on
 * the Settings page's interval (3s by default). Null before the first good response.
 * Follows the `pollSeq` rule: a tick is skipped while a request is out and only the newest answer is applied, so the figure never steps back.
 */
export function useSessionSpend(id: string): SessionSpend | null {
  const [spend, setSpend] = useState<SessionSpend | null>(null);
  const { settings: { refreshMs } } = useSettings();

  useEffect(() => {
    let alive = true;
    setSpend(null); // clear stale data when switching sessions
    const seq = createPollSeq();

    async function poll() {
      const n = seq.next(false);
      if (n === null) return;
      try {
        const res = await pollFetch(`/api/sessions/${encodeURIComponent(id)}/spend`);
        // Settled here too: a path that returns without settling would keep every later tick skipped.
        if (!res.ok) { seq.settle(n); return; }
        const data: SessionSpend = await res.json();
        if (seq.settle(n) && alive) setSpend(prev => acceptSpend(prev, data));
      } catch {
        seq.settle(n); // keep last snapshot
      }
    }

    poll();
    const timer = setInterval(poll, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  return spend;
}
