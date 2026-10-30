/**
 * scan-snapshot.ts — one scan of the session rows with every RAM-store injection applied: the held question, plan and reply-window ids, permission waits,
 * the desktop app's archived ids and the Stop states. The scan half of `GET /api/sessions`, and what the hub's sessions widget reads, so it lives here and
 * not in the router: a lib module importing `api.ts` would close a cycle through every route the router pulls in.
 */

import { archivedSessionIds, desktopLiveSessionIds } from './archived.js';
import type { Config } from './config.js';
import { messageSessionIds } from './messages.js';
import { pendingSessionIds, sweepDecided as sweepDecidedPending } from './pending.js';
import { permissionWaits } from './permissions.js';
import { planSessionIds, sweepDecided as sweepDecidedPlans } from './plans.js';
import { lastMessageMs, listTranscripts, projectsRoot, scanSessions } from './scan.js';
import type { TranscriptRef } from './scan.js';
import { stopStates } from './spawn.js';
import type { SessionsResponse } from '../../shared/types.js';

/**
 * Release held question/plan waits whose session has moved on — the terminal
 * card decided it. The CLI renders that card *alongside* the hook and, when the
 * card wins, abandons the hook without killing it: `curl` stays connected, so no
 * socket closes and neither store hears anything. Without this the entry sits
 * out its whole deadline (up to 10 min) with the dashboard still offering an
 * answer nothing will read.
 *
 * Runs off the scan tick and only while holds exist, so an idle server does no
 * extra IO — the same shape as the stores' idle reaper in `wait-store.ts`. One transcript read
 * per held wait, and there is at most one per session; the ids resolve from the
 * scan's own listing, so a held wait costs no directory walk.
 */
function sweepTerminalDecisions(root: string, transcripts: readonly TranscriptRef[]): void {
  if (pendingSessionIds().size === 0 && planSessionIds().size === 0) return;
  const movedOn = (sessionId: string, askedAtMs: number): boolean => {
    const ms = lastMessageMs(root, sessionId, transcripts);
    return ms !== null && ms > askedAtMs;
  };
  sweepDecidedPending(movedOn);
  sweepDecidedPlans(movedOn);
}

/** One scan of the session rows with every RAM-store injection applied — what `/api/sessions` serves before launches and usage are attached. */
export function scanSnapshot(config: Config, projects?: ReadonlySet<string> | null): SessionsResponse {
  // One listing per request, shared by the sweep and the scan.
  const root = projectsRoot();
  const transcripts = listTranscripts(root);
  // Before the scan, not after: a wait the terminal already decided must not
  // colour this tick's row blue either.
  sweepTerminalDecisions(root, transcripts);
  // pendingIds comes from the RAM store, not disk: a question held by the
  // AskUserQuestion hook is flagged on its row before the transcript knows
  // about it, so it's visible without opening the chat drawer. planIds and
  // messageIds are the same thing, for a held ExitPlanMode call and a held
  // Stop-hook reply window respectively.
  // permissionWaits likewise: a terminal permission dialog is TUI-only and
  // never reaches the transcript, so the Notification hook is the only way the
  // scan can know a session is parked on one.
  // archivedIds mirrors the desktop app's own list: "delete" there is an
  // archive that leaves the transcript on disk, so without this the row keeps
  // showing until it ages out of the lookback window. Read here, not in
  // scan.ts, so the scan stays free of the app's store (see archived.ts).
  return scanSessions(config, {
    skipProcScan: config.skipProcScan,
    pendingIds: pendingSessionIds(),
    planIds: planSessionIds(),
    messageIds: messageSessionIds(),
    permissionWaits: permissionWaits(),
    archivedIds: archivedSessionIds(),
    desktopOwnedIds: desktopLiveSessionIds(),
    // stopStates is the same injection again, and the only one that is not a
    // hint about a wait: it says which rows this server can actually signal,
    // so the Stop control is offered only where it would work.
    stopStates: stopStates(),
    projects,
    root,
    transcripts
  });
}
