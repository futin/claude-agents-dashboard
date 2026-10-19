/**
 * Which kind of 403 a write got. The server answers `bad token` when a token is configured and the caller's is wrong or missing, and
 * `read-only from this network` when no token is set, so nothing the caller types can unlock the write — a token prompt would be a dead end there.
 */

/** Shown wherever a token prompt would be, when the network is read-only. */
export const READ_ONLY_TEXT = 'Read-only from this network: open the dashboard through Tailscale, or set ANSWER_TOKEN.';

/** `null` for anything but a 403; `'read-only'` only for the server's exact read-only body; every other 403 is a token refusal, as before. */
export function refusalKind(status: number, body: unknown): 'token' | 'read-only' | null {
  if (status !== 403) return null;
  if (body !== null && typeof body === 'object' && (body as { error?: unknown }).error === 'read-only from this network') return 'read-only';
  return 'token';
}
