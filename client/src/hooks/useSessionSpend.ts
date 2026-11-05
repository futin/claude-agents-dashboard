import { useEffect, useState } from 'react';

import { acceptSpend } from '../lib/sessionSpend';
import { useSettings } from './useSettings';
import type { SessionSpend } from '../../../shared/types';

/**
 * Fetch `/api/sessions/:id/spend` while the session's drawer is open, polling on
 * the Settings page's interval (3s by default). Null before the first good response.
 */
export function useSessionSpend(id: string): SessionSpend | null {
  const [spend, setSpend] = useState<SessionSpend | null>(null);
  const { settings: { refreshMs } } = useSettings();

  useEffect(() => {
    let alive = true;
    setSpend(null); // clear stale data when switching sessions

    async function poll() {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/spend`);
        if (!res.ok) return;
        const data: SessionSpend = await res.json();
        if (alive) setSpend(prev => acceptSpend(prev, data));
      } catch {
        /* keep last snapshot */
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
