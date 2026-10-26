/**
 * serverSettingsSave.ts — the line a failed `POST /api/settings` leaves on the Settings page. Apart from React so a test can pin every status.
 *
 * A 403 is not here: `useServerSettings` turns it into the token prompt or `READ_ONLY_TEXT` through `refusalKind`, which already have their own rows.
 */

/** `null` for a 2xx or a 403; otherwise why the row snapped back. `status` 0 is a request that never got an answer. */
export function settingsSaveFailure(status: number): string | null {
  if ((status >= 200 && status < 300) || status === 403) return null;
  if (status === 0) return "Couldn't reach the server — the setting was not saved.";
  if (status === 400) return 'The server refused that value — the setting was not saved.';
  return `Couldn't save the setting (HTTP ${status}).`;
}
