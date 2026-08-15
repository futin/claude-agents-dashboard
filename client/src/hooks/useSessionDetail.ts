import { useEffect, useState } from 'react';

import { useSettings } from './useSettings';
import type { SessionDetail } from '../../../shared/types';

/**
 * Fetch `/api/sessions/:id` (a session's subagent activity) while that session
 * is selected, polling on the Settings page's interval (3s by default). Returns
 * null when `id` is null or before the first response. Full-file read on the
 * server, so it only runs on selection.
 */
export function useSessionDetail(id: string | null): SessionDetail | null {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const { settings: { refreshMs } } = useSettings();

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null); // clear stale data when switching sessions

    async function poll() {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id as string)}`);
        const data: SessionDetail = await res.json();
        if (alive) setDetail(data);
      } catch {
        /* keep last snapshot; the row still shows what it had */
      }
    }

    poll();
    const timer = setInterval(poll, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  return detail;
}
