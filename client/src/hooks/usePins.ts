import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { postWrite, replyError } from '../lib/postWrite';
import type { WriteResult } from '../lib/postWrite';
import { READ_ONLY_TEXT } from '../lib/writeRefusal';
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

/** A 403's note: the token prompt, or `READ_ONLY_TEXT` when no token could help. */
function refusalText(result: WriteResult): string {
  return result.refusal === 'read-only' ? READ_ONLY_TEXT : TOKEN_TEXT;
}

/** A refused write's note: the 403 text, else the server's own message. */
function failureText(result: WriteResult): string {
  if (result.refusal) return refusalText(result);
  return replyError(result.body) ?? `Failed (${result.status}).`;
}

/** The fresh payload a successful pin write answers with, or null when the reply is not one. */
function pinsOf(result: WriteResult): PinsResponse | null {
  const body = result.body as PinsResponse | undefined;
  return Array.isArray(body?.pinned) ? body : null;
}

/**
 * Pinned projects (#161) over `GET/POST /api/pins` and `POST /api/pins/order`, for the launch sheet and
 * Management › Projects. Fetched once on mount, not polled — the pin list changes
 * only through this tab's own Pin/Unpin or reorder; another tab's change surfaces
 * as the reorder's 409. A successful POST answers with the fresh payload,
 * so no second request follows it. Same `dashboard.answerToken` Bearer pattern
 * as `useServerSettings`.
 */
export function usePins(): PinsControl {
  const [pins, setPins] = useState<PinsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [token] = useAnswerToken();

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
    try {
      const result = await postWrite('/api/pins', { token, body: { dirName, pinned } });
      const fresh = result.ok ? pinsOf(result) : null;
      if (fresh) {
        setPins(fresh);
        return null;
      }
      return result.status === 0 || result.ok ? NETWORK_TEXT : failureText(result);
    } finally {
      setBusy(null);
    }
  }, [token]);

  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  const reorder = useCallback(async (order: string[]): Promise<string | null> => {
    // Synchronous, before the first await: usePinReorder ends its drag right after calling this and relies on the rows already holding `order`.
    const before = pinsRef.current;
    setBusy('order');
    if (before) setPins({ ...before, pinned: applyPinOrder(before.pinned, order) });
    try {
      const result = await postWrite('/api/pins/order', { token, body: { order } });
      const saved = result.ok ? pinsOf(result) : null;
      if (saved) {
        setPins(saved);
        return null;
      }
      if (result.status === 409) {
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
      return result.status === 0 || result.ok ? NETWORK_TEXT : failureText(result);
    } finally {
      setBusy(null);
    }
  }, [token]);

  return { pins, busy, setPin, reorder };
}
