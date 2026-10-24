import { useEffect, useRef, useState } from 'react';

import { acceptPrAnswer } from '../lib/pr';
import { useSettings } from './useSettings';
import type { SessionPr, SessionPrResponse } from '../../../shared/types';

/**
 * Poll `/api/sessions/:id/pr` while the drawer is open: the newest PR the session created, with its live `gh` state. A network failure keeps what is
 * shown; every answer goes through {@link acceptPrAnswer}.
 */
export function usePullRequest(id: string): SessionPr {
  const [pr, setPr] = useState<SessionPr>(null);
  const { settings: { refreshMs } } = useSettings();
  // Read at answer time: the server echoes the id it was asked for, so only the latest id can reject an answer that was in flight across a switch.
  const idRef = useRef(id);
  idRef.current = id;

  // Kept apart from the poll so retuning the refresh rate does not blank a card already on screen.
  useEffect(() => { setPr(null); }, [id]);

  useEffect(() => {
    let live = true;
    // A cold `gh` read can outlast a 3s tick; one request at a time per poll loop.
    let busy = false;

    async function poll(): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/pr`);
        const body = (await res.json()) as SessionPrResponse;
        if (live) setPr(prev => acceptPrAnswer(idRef.current, body, prev));
      } catch {
        // keep the last value; the next tick retries
      } finally {
        busy = false;
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  return pr;
}
