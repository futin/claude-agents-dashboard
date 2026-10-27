/**
 * openFolder.ts — the status → note mapping behind the Open folder key, kept out of `hooks/useOpenFolder.ts` so a node test can reach it.
 *
 * The server's two 403s mean different things — a missing token versus a folder the pin list no longer shows — so the body's `error` picks the note.
 */

import { READ_ONLY_TEXT, refusalKind } from './writeRefusal';

/** Why `POST /api/open-folder` did nothing, in words for the user, or `null` for a 200. `reply` is the parsed body, read only on a 403. */
export function openFolderNote(status: number, reply: unknown): string | null {
  if (status === 200) return null;
  if (status === 403) {
    if (refusalKind(status, reply) === 'read-only') return READ_ONLY_TEXT;
    const error = reply !== null && typeof reply === 'object' ? (reply as { error?: unknown }).error : undefined;
    return error === 'bad token'
      ? 'Open folder needs the Answer token — set it under Settings › Local › Connection.'
      : 'That folder is no longer pinned.';
  }
  if (status === 501) return 'Open folder works only when the dashboard server runs on macOS.';
  return "Couldn't open the folder.";
}
