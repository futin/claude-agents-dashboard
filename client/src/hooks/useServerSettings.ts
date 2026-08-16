import { useCallback, useEffect, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import type { NotifyPatch, ServerSettings } from '../../../shared/types';

export interface ServerSettingsControl {
  state: ServerSettings | null;
  saving: boolean;
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
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
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
      setSaving(false);
    }
  }, [token]);

  // The server merges a partial `notify` block, so a single flipped checkbox is
  // the whole request — no need to round-trip the rest of the policy.
  const saveNotify = useCallback(
    (patch: NotifyPatch) => save({ notify: patch } as unknown as Partial<ServerSettings>),
    [save]
  );

  return { state, saving, needsToken, save, saveNotify };
}
