/**
 * serverSettingsSave.ts — what one `POST /api/settings` leaves on the Settings page: the failure line, the 403 flags, the settings to show and which keys
 * still read `saving…`. Apart from React so a test can pin every status; `useServerSettings` only applies the results.
 *
 * A 403 has no failure line: it becomes the token prompt or `READ_ONLY_TEXT` through `refusalFlags`, which already have their own rows.
 */
import type { ServerSettings } from '../../../shared/types';
import type { WriteResult } from './postWrite';
import { refusalFlags } from './writeRefusal';

/** `null` for a 2xx or a 403; otherwise why the row snapped back. `status` 0 is a request that never got an answer. */
export function settingsSaveFailure(status: number): string | null {
  if ((status >= 200 && status < 300) || status === 403) return null;
  if (status === 0) return "Couldn't reach the server — the setting was not saved.";
  if (status === 400) return 'The server refused that value — the setting was not saved.';
  return `Couldn't save the setting (HTTP ${status}).`;
}

/** What a save's answer changes. `flags` null leaves `needsToken` / `readOnly` as they were; `state` null leaves the shown settings as they were. */
export interface SettingsSaveOutcome {
  saveError: string | null;
  flags: { needsToken: boolean; readOnly: boolean } | null;
  state: ServerSettings | null;
}

/**
 * A 403 sets its own flag and clears the other; a 2xx clears both and shows what the server echoed, not what was sent — the server clamps, so its body is
 * what the hooks will actually read. Any other status changes neither.
 */
export function settingsSaveOutcome(result: WriteResult): SettingsSaveOutcome {
  const saveError = settingsSaveFailure(result.status);
  if (result.refusal) return { saveError, flags: refusalFlags(result.refusal), state: null };
  if (!result.ok) return { saveError, flags: null, state: null };
  const body = result.body as ServerSettings | undefined;
  return { saveError, flags: { needsToken: false, readOnly: false }, state: typeof body?.idleSecs === 'number' ? body : null };
}

/**
 * The keys of every save still in flight are a multiset: a key is added per request and removed once per response. Held that way rather than as one key so
 * two overlapping saves of one setting (a fast double-toggle) can't have the first response clear the second's `saving…`.
 */
export function addSavingKeys(inFlight: readonly string[], keys: readonly string[]): string[] {
  return [...inFlight, ...keys];
}

/** Removes one occurrence of each key, so another save of the same key still in flight keeps its own. */
export function removeSavingKeys(inFlight: readonly string[], keys: readonly string[]): string[] {
  const next = [...inFlight];
  for (const key of keys) {
    const at = next.indexOf(key);
    if (at !== -1) next.splice(at, 1);
  }
  return next;
}
