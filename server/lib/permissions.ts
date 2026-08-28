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
 * See `docs/subsystems/permission-notify.md`.
 */

/** Backstop reaper. Long, because the primary clear is the transcript check. */
export const PERMISSION_TTL_MS = 30 * 60_000;
/** Cap on the hook-supplied message ("Claude needs your permission to use Bash"). */
export const MESSAGE_CAP = 200;
/**
 * How long after a notify the *same* session's next notify counts as the same
 * dialog, and so must not push again.
 *
 * `permission-notify.sh` is deliberately registered on two hook events —
 * `PermissionRequest` fires as the prompt is drawn, `Notification` ~6s later on
 * engines that emit it — because neither one covers every engine. That has
 * always been harmless for the flag this module keeps (one entry per session,
 * re-armed), but the route also pushes, and one dialog was buzzing the phone
 * twice, six seconds apart.
 *
 * 15s: comfortably past the ~6s pairing, short enough that a genuinely new
 * dialog still buzzes. Deliberately NOT `PERMISSION_TTL_MS` — that flag lives
 * 30 minutes, and reusing it would silence every later dialog in the session.
 */
export const PERMISSION_PUSH_DEDUPE_MS = 15_000;
/**
 * How long after a wait is handed to the terminal that session's next permission
 * report is treated as *that* dialog, and so must not push.
 *
 * Tapping "answer in the terminal" settles the wait as `dismissed`; the idle
 * sweep settles it `released`; an unanswered one settles `timeout`, and a newer
 * question settles the old one `superseded`. Every status but `answered` means
 * the same thing — the terminal dialog takes over — and that dialog then
 * reports itself here ~10-15s later. Pushing it buzzes the phone about a prompt
 * the user just chose to walk over and answer.
 *
 * The HID idle gate cannot catch this case: the tap happens on a phone, so the
 * Mac has been idle the whole time and `requireAfk` passes.
 *
 * 30s covers the observed dismiss→dialog gap with room, and expires long before
 * an unrelated dialog later in the session.
 */
export const TERMINAL_HANDOFF_MS = 30_000;

interface Entry {
  /** Epoch ms the notification arrived — compared against the transcript. */
  notifiedAt: number;
  message: string;
  timer: NodeJS.Timeout;
}

const entries = new Map<string, Entry>();

/** `sessionId → when a wait for it last fell back to the terminal dialog`. */
const handoffs = new Map<string, number>();

/**
 * Record that a wait for this session just fell back to the terminal dialog, so
 * the permission report that follows is that dialog and is not news.
 *
 * Called from every wait store's `settle` on any non-`answered` status. Plain
 * timestamps rather than timers: there is nothing to clean up if the dialog
 * never reports, and a stale entry is inert once its window passes.
 */
export function noteTerminalHandoff(sessionId: string, now: number = Date.now()): void {
  // Prune on write — the map is only ever read for the session being reported,
  // so nothing else would ever evict a session that has gone away.
  for (const [id, at] of handoffs) {
    if (now - at >= TERMINAL_HANDOFF_MS) handoffs.delete(id);
  }
  handoffs.set(sessionId, now);
}

/** Whether this session handed a wait to the terminal within the window. */
export function handedToTerminal(sessionId: string, now: number = Date.now()): boolean {
  const at = handoffs.get(sessionId);
  return at !== undefined && now - at < TERMINAL_HANDOFF_MS;
}

/**
 * Record that a session is showing a permission dialog. One entry per session
 * (the CLI shows one dialog at a time); a second notify supersedes the first,
 * which re-arms both the timestamp and the TTL.
 *
 * Returns whether this is worth pushing about: a *new* dialog rather than the
 * second hook reporting the one already recorded (see
 * {@link PERMISSION_PUSH_DEDUPE_MS}), and not one the user just sent to the
 * terminal themselves (see {@link TERMINAL_HANDOFF_MS}).
 * The flag itself is written either way; only the caller's push depends on it,
 * which keeps the display path (idempotent by design) and the notify path
 * (emphatically not) from having to agree about anything else.
 *
 * `now` and `ttlMs` are injectable so the tests don't have to sleep.
 */
export function notifyPermission(
  sessionId: string,
  message?: unknown,
  ttlMs: number = PERMISSION_TTL_MS,
  now: number = Date.now()
): boolean {
  const prev = entries.get(sessionId);
  // Measured from the last notify, not the first: two hooks is the case this
  // exists for, and a third report would be the same dialog too.
  const unseen = !prev || now - prev.notifiedAt >= PERMISSION_PUSH_DEDUPE_MS;
  // A dialog the user asked for is not news, however new it is to this store.
  const fresh = unseen && !handedToTerminal(sessionId, now);
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
  return fresh;
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
  handoffs.clear();
}
