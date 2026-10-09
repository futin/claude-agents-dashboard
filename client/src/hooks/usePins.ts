import { useCallback, useEffect, useRef, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import { applyPinOrder } from '../lib/pins';
import type { PinsResponse } from '../../../shared/types';

export interface PinsControl {
  /** null until `GET /api/pins` answers, or if it never does. */
  pins: PinsResponse | null;
  /** The dirName whose pin/unpin is in flight, `'order'` while a reorder is, else null. Real dirNames start with `-`, so the two never collide. */
  busy: string | null;
  /**
   * Pin or unpin one project. Resolves null on success, else the reason to show
   * inline — the server's own message, or a fixed one for a network failure.
   * Never throws.
   */
  setPin: (dirName: string, pinned: boolean) => Promise<string | null>;
  /**
   * Save the whole pin list in a new order. The rows take that order at once, before the request, and roll back if it is refused. Same resolution as
   * `setPin`: null on success, else the text to show. Never throws.
   */
  reorder: (order: string[]) => Promise<string | null>;
}

const TOKEN_TEXT = 'The server refused the request — set the Answer token under Settings › Local › Connection.';
const NETWORK_TEXT = 'Could not reach the server.';

/**
 * Pinned projects (#161) over `GET/POST /api/pins` and `POST /api/pins/order`, for the launch sheet and
 * Management › Pinned. Fetched once on mount, not polled — the pin list changes
 * only through this tab's own Pin/Unpin or reorder; another tab's change surfaces
 * as the reorder's 409. A successful POST answers with the fresh payload,
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
      if (res.status === 403) return TOKEN_TEXT;
      const body = await res.json().catch(() => null) as { error?: string } | null;
      return body?.error ?? `Failed (${res.status}).`;
    } catch {
      return NETWORK_TEXT;
    } finally {
      setBusy(null);
    }
  }, [token]);

  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  const reorder = useCallback(async (order: string[]): Promise<string | null> => {
    // Synchronous, before the first await: the picker drops its drag draft right after calling this and relies on the rows already holding `order`.
    const before = pinsRef.current;
    setBusy('order');
    if (before) setPins({ ...before, pinned: applyPinOrder(before.pinned, order) });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/pins/order', { method: 'POST', headers, body: JSON.stringify({ order }) });
      if (res.ok) {
        setPins((await res.json()) as PinsResponse);
        return null;
      }
      if (res.status === 409) {
        // The stored set changed under this tab, so the pre-drag rows are stale too: show the server's list instead.
        try {
          const fresh = await fetch('/api/pins');
          const body = fresh.ok ? await fresh.json() as PinsResponse : null;
          if (Array.isArray(body?.pinned)) {
            setPins(body);
            return 'Pins changed in another tab — reloaded.';
          }
        } catch { /* fall through to the rollback */ }
        setPins(before);
        return NETWORK_TEXT;
      }
      setPins(before);
      if (res.status === 403) return TOKEN_TEXT;
      const body = await res.json().catch(() => null) as { error?: string } | null;
      return body?.error ?? `Failed (${res.status}).`;
    } catch {
      setPins(before);
      return NETWORK_TEXT;
    } finally {
      setBusy(null);
    }
  }, [token]);

  return { pins, busy, setPin, reorder };
}
