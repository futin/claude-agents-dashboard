import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { postWrite } from '../lib/postWrite';
import { pinWriteOutcome, settleReorder } from '../lib/pinWrite';
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
   * Never throws. The text can also mean the write stood but the list could not be re-read, so the rows lag until a reload.
   */
  setPin: (dirName: string, pinned: boolean) => Promise<string | null>;
  /**
   * Save the whole pin list in a new order. The rows take that order at once, before the request, and roll back if it is refused; a write that saved but
   * could not re-read the list keeps them. Same resolution as `setPin`: null on success, else the text to show. Never throws.
   */
  reorder: (order: string[]) => Promise<string | null>;
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
      const outcome = pinWriteOutcome(await postWrite('/api/pins', { token, body: { dirName, pinned } }));
      if (outcome.kind === 'fresh') {
        setPins(outcome.pins);
        return null;
      }
      return outcome.text;
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
      const outcome = pinWriteOutcome(await postWrite('/api/pins/order', { token, body: { order } }));
      const settled = await settleReorder(outcome, before, () => fetch('/api/pins'));
      if ('pins' in settled) setPins(settled.pins ?? null);
      return settled.text;
    } finally {
      setBusy(null);
    }
  }, [token]);

  return { pins, busy, setPin, reorder };
}
