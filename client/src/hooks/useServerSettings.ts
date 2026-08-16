import { useCallback, useEffect, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import type { NotifyPatch, ServerSettings } from '../../../shared/types';

/** What a caller can ask about: the two number fields, or the notify policy. */
export type SavingKey = 'idleSecs' | 'answerSecs' | 'notify';

export interface ServerSettingsControl {
  state: ServerSettings | null;
  /**
   * Is *this* setting the one currently in flight?
   *
   * Keyed rather than a single boolean because every control on the page shares
   * one `save`, so a plain flag made a push toggle light up the `saving…` next to
   * `Away after` and `Answer window` — two rows the user did not touch, which
   * flicker as the span mounts and unmounts inside their flex control.
   */
  isSaving: (key: SavingKey) => boolean;
  /** Set when the server refused the token. */
  needsToken: boolean;
  save: (patch: Partial<ServerSettings>) => Promise<void>;
  /** Patch one or more notify keys. Merged server-side, so send only what changed. */
  saveNotify: (patch: NotifyPatch) => Promise<void>;
}

/**
 * The handful of settings that can't be per-device, over `GET/POST
 * /api/settings`. Today that is the idle threshold, the answer window and the
 * push-notification policy — see `server/lib/settings.ts` for why they can't
 * live in localStorage with the rest.
 *
 * Fetched once when the Settings page opens rather than polled: unlike the
 * remote-answer switch, nothing else in the app flips this behind your back.
 */
export function useServerSettings(): ServerSettingsControl {
  const [state, setState] = useState<ServerSettings | null>(null);
  /**
   * The keys of every save still in flight, as a multiset — a key is pushed per
   * request and removed per response. Held that way rather than as one key so
   * that two overlapping saves (a fast double-toggle) can't have the first
   * response clear the second's indicator.
   */
  const [savingKeys, setSavingKeys] = useState<readonly string[]>([]);
  const [needsToken, setNeedsToken] = useState(false);
  const [token] = usePersistedState<string>('dashboard.answerToken', '');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        const body = (await res.json()) as ServerSettings;
        if (live && typeof body?.idleSecs === 'number') setState(body);
      } catch {
        /* leave null — the page hides the row rather than showing a wrong value */
      }
    })();
    return () => { live = false; };
  }, []);

  const save = useCallback(async (patch: Partial<ServerSettings>) => {
    // The patch names what is being saved, so the rows don't have to be told.
    const keys = Object.keys(patch);
    setSavingKeys(prev => [...prev, ...keys]);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers, body: JSON.stringify(patch) });
      if (res.status === 403) {
        setNeedsToken(true);
      } else if (res.ok) {
        setNeedsToken(false);
        // Trust the response, not the request: the server clamps, so what it
        // echoes back is what the hooks will actually read.
        setState((await res.json()) as ServerSettings);
      }
    } catch {
      /* keep the last known value; the row stays on the server's number */
    } finally {
      setSavingKeys(prev => {
        const next = [...prev];
        for (const key of keys) {
          const at = next.indexOf(key);
          if (at !== -1) next.splice(at, 1);
        }
        return next;
      });
    }
  }, [token]);

  const isSaving = useCallback((key: SavingKey) => savingKeys.includes(key), [savingKeys]);

  // The server merges a partial `notify` block, so a single flipped checkbox is
  // the whole request — no need to round-trip the rest of the policy.
  const saveNotify = useCallback(
    (patch: NotifyPatch) => save({ notify: patch } as unknown as Partial<ServerSettings>),
    [save]
  );

  return { state, isSaving, needsToken, save, saveNotify };
}
