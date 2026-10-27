import { useCallback, useEffect, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { postWrite } from '../lib/postWrite';
import { settingsSaveFailure } from '../lib/serverSettingsSave';
import type { NotifyPatch, ServerSettings, ServerSettingsPatch } from '../../../shared/types';

/** What a caller can ask about: any key a save can carry, the notify policy included. */
export type SavingKey = keyof ServerSettingsPatch;

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
  /** Set when the server says this network is read-only: no token can help, so the surface says so instead of prompting. */
  readOnly: boolean;
  /** Why the last save did not land — a 400, a 500, no answer — or null. A 403 is `needsToken` / `readOnly` instead. */
  saveError: string | null;
  save: (patch: ServerSettingsPatch) => Promise<void>;
  /** Patch one or more notify keys. Merged server-side, so send only what changed. */
  saveNotify: (patch: NotifyPatch) => Promise<void>;
}

/**
 * The handful of settings that can't be per-device, over `GET/POST
 * /api/settings`. Today that is the idle threshold, the answer window, the
 * push-notification policy, the usage-recording switch and the tailnet-trust switch — see
 * `server/lib/settings.ts` for why they can't live in localStorage with the
 * rest. (Recording is the clearest case: a per-device toggle cannot start a
 * server-side timer.)
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
  const [readOnly, setReadOnly] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [token] = useAnswerToken();

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

  const save = useCallback(async (patch: ServerSettingsPatch) => {
    // The patch names what is being saved, so the rows don't have to be told.
    const keys = Object.keys(patch);
    setSavingKeys(prev => [...prev, ...keys]);
    try {
      const result = await postWrite('/api/settings', { token, body: patch });
      // A network failure is status 0: the row keeps the server's last number, and the page says why.
      setSaveError(settingsSaveFailure(result.status));
      if (result.refusal) {
        const readOnlyNow = result.refusal === 'read-only';
        setReadOnly(readOnlyNow);
        setNeedsToken(!readOnlyNow);
      } else if (result.ok) {
        setNeedsToken(false);
        setReadOnly(false);
        // Trust the response, not the request: the server clamps, so what it
        // echoes back is what the hooks will actually read.
        const body = result.body as ServerSettings | undefined;
        if (typeof body?.idleSecs === 'number') setState(body);
      }
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
    (patch: NotifyPatch) => save({ notify: patch }),
    [save]
  );

  return { state, isSaving, needsToken, readOnly, saveError, save, saveNotify };
}
