import { useCallback, useEffect, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import type { HealthResponse, RemoteAnswerState } from '../../../shared/types';

/** Slow poll: the switch only changes when someone flips it. */
const POLL_MS = 15_000;

export interface RemoteAnswerControl {
  state: HealthResponse | null;
  busy: boolean;
  /** Set when the server refused the token. */
  needsToken: boolean;
  toggle: () => Promise<void>;
}

/**
 * The remote-answer switch behind the toolbar pill. Reads `GET /api/health` and
 * flips it with `POST /api/remote-answer`.
 *
 * Polled (not just fetched once) because the other surface can flip it — your
 * phone turning it on should show up on the laptop without a reload.
 */
export function useRemoteAnswer(): RemoteAnswerControl {
  const [state, setState] = useState<HealthResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [token] = usePersistedState<string>('dashboard.answerToken', '');

  useEffect(() => {
    let live = true;
    async function read(): Promise<void> {
      try {
        const res = await fetch('/api/health');
        const body = (await res.json()) as HealthResponse;
        if (live && typeof body?.remoteAnswer === 'boolean') setState(body);
      } catch {
        /* keep the last snapshot; the next tick retries */
      }
    }
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const toggle = useCallback(async () => {
    if (!state?.available || busy) return;
    setBusy(true);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/remote-answer', {
        method: 'POST', headers, body: JSON.stringify({ enabled: !state.enabled })
      });
      if (res.status === 403) {
        setNeedsToken(true);
      } else if (res.ok) {
        setNeedsToken(false);
        // This endpoint answers with the switch state alone — merge, or the
        // health-only fields (origin) would blank out until the next poll.
        const body = (await res.json()) as RemoteAnswerState;
        setState(prev => ({ ...(prev ?? { ok: true as const }), ...body }));
      }
    } catch {
      /* leave the pill as it was; the poll will re-sync */
    } finally {
      setBusy(false);
    }
  }, [state, busy, token]);

  return { state, busy, needsToken, toggle };
}
