/**
 * permissions.ts — the permission-wait store behind the `allow?` pill.
 *
 * The CLI's interactive permission dialog ("Do you want to allow Bash: pnpm
 * dev?") is drawn by the TUI and never written to the transcript, so a session
 * parked on one looks byte-for-byte like a session with a tool still running.
 * The `Notification` hook fires exactly when that dialog appears; it POSTs the
 * session id here, and the scan turns the flag into a row pill + drawer banner.
 *
 * Display-only. Unlike `pending.ts` there is no held socket and no resolve: the
 * CLI offers no way for anything outside the TUI to answer a permission dialog,
 * so this store records a fact and nothing more. Answering stays in the terminal.
 *
 * Everything is in memory: a restart drops every flag, which fails open (a row
 * simply reads as it did before the feature existed).
 *
 * Clearing is the scan's job, not this store's: answering the dialog (approve
 * OR deny) appends a record to the transcript, so `lastMessageTs > notifiedAt`
 * means the wait is over. The TTL below is only a backstop for the paths that
 * never append — a killed session, a dismissed dialog, a lost notify.
 *
 * See `.claude/rules/permission-notify.md`.
 */

/** Backstop reaper. Long, because the primary clear is the transcript check. */
export const PERMISSION_TTL_MS = 30 * 60_000;
/** Cap on the hook-supplied message ("Claude needs your permission to use Bash"). */
export const MESSAGE_CAP = 200;

interface Entry {
  /** Epoch ms the notification arrived — compared against the transcript. */
  notifiedAt: number;
  message: string;
  timer: NodeJS.Timeout;
}

const entries = new Map<string, Entry>();

/**
 * Record that a session is showing a permission dialog. One entry per session
 * (the CLI shows one dialog at a time); a second notify supersedes the first,
 * which re-arms both the timestamp and the TTL.
 *
 * `now` and `ttlMs` are injectable so the tests don't have to sleep.
 */
export function notifyPermission(
  sessionId: string,
  message?: unknown,
  ttlMs: number = PERMISSION_TTL_MS,
  now: number = Date.now()
): void {
  const prev = entries.get(sessionId);
  if (prev) clearTimeout(prev.timer);

  const entry: Entry = {
    notifiedAt: now,
    message: typeof message === 'string' ? message.slice(0, MESSAGE_CAP) : '',
    timer: setTimeout(() => {
      if (entries.get(sessionId) === entry) entries.delete(sessionId);
    }, Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : PERMISSION_TTL_MS)
  };
  // Never hold the process open for a display-only flag.
  entry.timer.unref?.();
  entries.set(sessionId, entry);
}

/**
 * Every session believed to be waiting on a permission dialog, as
 * `sessionId → notifiedAt`. A fresh Map: callers never get a handle on the
 * store's own state (same rule as `pendingSessionIds`).
 */
export function permissionWaits(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, entry] of entries) out.set(id, entry.notifiedAt);
  return out;
}

/** The message the hook reported, or '' — unused by the UI today (activity is richer). */
export function permissionMessage(sessionId: string): string {
  return entries.get(sessionId)?.message ?? '';
}

/** Drop a session's flag. Used by nothing in the request path — tests and future callers. */
export function clearPermission(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entries.delete(sessionId);
}

/** Test seam: drop every entry and its timer. */
export function resetPermissions(): void {
  for (const entry of entries.values()) clearTimeout(entry.timer);
  entries.clear();
}
