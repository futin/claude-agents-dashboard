import { useEffect, useRef, useState } from 'react';

import type { SessionsResponse } from '../../../shared/types';

const POLL_MS = 3000;

export interface SessionsState {
  data: SessionsResponse | null;
  /** false once a poll has failed (server stopped?). */
  connected: boolean;
}

/** Poll `/api/sessions` every 3s. Returns the latest snapshot + link health. */
export function useSessions(): SessionsState {
  const [state, setState] = useState<SessionsState>({ data: null, connected: true });
  const timer = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch('/api/sessions');
        const data: SessionsResponse = await res.json();
        if (alive) setState({ data, connected: true });
      } catch {
        if (alive) setState(prev => ({ data: prev.data, connected: false }));
      }
    }

    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  return state;
}
