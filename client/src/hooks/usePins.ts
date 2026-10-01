import { useCallback, useEffect, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import type { PinsResponse } from '../../../shared/types';

export interface PinsControl {
  /** null until `GET /api/pins` answers, or if it never does. */
  pins: PinsResponse | null;
  /** The dirName whose pin/unpin is in flight, if any. */
  busy: string | null;
  /**
   * Pin or unpin one project. Resolves null on success, else the reason to show
   * inline — the server's own message, or a fixed one for a network failure.
   * Never throws.
   */
  setPin: (dirName: string, pinned: boolean) => Promise<string | null>;
}

/**
 * Pinned projects (#161) over `GET/POST /api/pins`, for the launch sheet and
 * Management › Pinned. Fetched once on mount, not polled — the pin list changes
 * only when someone clicks. A successful POST answers with the fresh payload,
 * so no second request follows it. Same `dashboard.answerToken` Bearer pattern
 * as `useServerSettings`.
 */
export function usePins(): PinsControl {
  const [pins, setPins] = useState<PinsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [token] = usePersistedState<string>('dashboard.answerToken', '');

  useEffect(() => {
    let live = true;
    fetch('/api/pins')
      .then(res => res.json() as Promise<PinsResponse>)
      .then(body => { if (live && Array.isArray(body?.pinned)) setPins(body); })
      .catch(() => { /* leave null — both UIs then hide what depends on it */ });
    return () => { live = false; };
  }, []);

  const setPin = useCallback(async (dirName: string, pinned: boolean): Promise<string | null> => {
    setBusy(dirName);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/pins', { method: 'POST', headers, body: JSON.stringify({ dirName, pinned }) });
      if (res.ok) {
        setPins((await res.json()) as PinsResponse);
        return null;
      }
      if (res.status === 403) return 'The server refused the request — set the Answer token under Settings › Local › Connection.';
      const body = await res.json().catch(() => null) as { error?: string } | null;
      return body?.error ?? `Failed (${res.status}).`;
    } catch {
      return 'Could not reach the server.';
    } finally {
      setBusy(null);
    }
  }, [token]);

  return { pins, busy, setPin };
}
