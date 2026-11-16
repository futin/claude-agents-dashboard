import { useEffect, useState } from 'react';

import { useSettings } from './useSettings';
import { createPollSeq, pollFetch } from '../lib/pollSeq';
import { EMPTY_DETAIL, nextDetail, type DetailState } from '../lib/sessionDetail';

/**
 * Fetch `/api/sessions/:id` (a session's subagent activity) while that session is selected, polling on the Settings page's interval (3s by default).
 * Full-file read on the server, so it only runs on selection — and, like the other poll hooks, a tick is skipped while a fetch is out (`createPollSeq`),
 * each fetch is bounded (`pollFetch`), and only the newest answer is applied. A failed answer keeps the last good snapshot (`nextDetail`): `failed` is set
 * only when the id's first answer failed, so one transient 404 or 500 never replaces an agent list already on screen.
 */
export function useSessionDetail(id: string | null): DetailState {
  const [state, setState] = useState<DetailState>(EMPTY_DETAIL);
  const { settings: { refreshMs } } = useSettings();

  useEffect(() => {
    setState(EMPTY_DETAIL); // clear stale data when switching sessions
    if (!id) return;
    let alive = true;
    const seq = createPollSeq();

    const poll = () => {
      const mine = seq.next(false);
      if (mine === null) return;
      pollFetch(`/api/sessions/${encodeURIComponent(id)}`)
        .then(async res => ({ ok: res.ok, body: await res.json().catch(() => null) as unknown }))
        .catch(() => ({ ok: false, body: null as unknown }))
        .then(({ ok, body }) => {
          if (alive && seq.settle(mine)) setState(prev => nextDetail(prev, ok, body));
        });
    };

    poll();
    const timer = setInterval(poll, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  return state;
}
