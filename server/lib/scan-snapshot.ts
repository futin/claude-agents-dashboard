/**
 * scan-snapshot.ts — one scan of the session rows with every RAM-store injection applied: the held question, plan and reply-window ids, permission waits,
 * the desktop app's archived ids and the Stop states. The scan half of `GET /api/sessions`, and what the hub's sessions widget reads, so it lives here and
 * not in the router: a lib module importing `api.ts` would close a cycle through every route the router pulls in.
 */

import { archivedSessionIds, desktopLiveSessionIds } from './archived.js';
import type { Config } from './config.js';
import { handOverFailedIds } from './handover.js';
import { messageSessionIds } from './messages.js';
import { pendingSessionIds, sweepDecided as sweepDecidedPending } from './pending.js';
import { permissionWaits } from './permissions.js';
import { planSessionIds, sweepDecided as sweepDecidedPlans } from './plans.js';
import { lastMessageMs, probeProcesses, projectsRoot, scanSessions } from './scan.js';
import type { ProcProbe, TranscriptRef } from './scan.js';
import { stopStates } from './spawn.js';
import { sharedListing } from './transcript-listing.js';
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

/**
 * How long a finished process probe answers every reader. Under the 3 s client poll, so one tab still gets a fresh probe on each poll, while a second
 * tab and the hub tile inside the same second share it. Serving a stale probe instead would show a just-launched session `idle` for a whole poll.
 */
export const PROBE_TTL_MS = 1000;

/**
 * How old a held transcript listing the poll may read, for the same reason as {@link PROBE_TTL_MS}: under the 3 s poll, so one tab still lists fresh on
 * every poll, while a second tab and the hub tile inside the same second share one walk.
 */
export const POLL_LISTING_MAX_AGE_MS = 1000;

let probeInFlight: Promise<ProcProbe> | null = null;
let lastProbe: { probe: ProcProbe; doneAt: number } | null = null;
let probeClock: () => number = Date.now;

/** Test seam: forget the cached and in-flight probe, and optionally swap the clock the TTL and the poll's listing age read. */
export function resetProcProbeCache(clock: () => number = Date.now): void {
  probeInFlight = null;
  lastProbe = null;
  probeClock = clock;
}

/**
 * The process probe every `/api/sessions` reader shares: a call while one runs joins it, and one within {@link PROBE_TTL_MS} of its completion reuses
 * its answer. null when the config switches the probe off (Docker, where `ps` sees only the container).
 */
export function sharedProcProbe(config: Config): Promise<ProcProbe | null> {
  if (config.skipProcScan) return Promise.resolve(null);
  if (probeInFlight) return probeInFlight;
  if (lastProbe && probeClock() - lastProbe.doneAt < PROBE_TTL_MS) return Promise.resolve(lastProbe.probe);
  const run = probeProcesses()
    .then(probe => { lastProbe = { probe, doneAt: probeClock() }; return probe; })
    .finally(() => { probeInFlight = null; });
  probeInFlight = run;
  return run;
}

/** One scan of the session rows with every RAM-store injection applied — what `/api/sessions` serves before launches and usage are attached. */
export async function scanSnapshot(config: Config, projects?: ReadonlySet<string> | null): Promise<SessionsResponse> {
  const proc = await sharedProcProbe(config);
  const root = projectsRoot();
  // One listing shared by the sweep and the scan: the held listing every request path reads (`transcript-listing.ts`), walked afresh once it is over
  // POLL_LISTING_MAX_AGE_MS old. A held one may predate this request's probe by up to that age; the poll accepts that lag, as it does the probe's TTL.
  const transcripts = sharedListing(root, probeClock(), POLL_LISTING_MAX_AGE_MS);
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
    proc,
    pendingIds: pendingSessionIds(),
    planIds: planSessionIds(),
    messageIds: messageSessionIds(),
    permissionWaits: permissionWaits(),
    archivedIds: archivedSessionIds(),
    desktopOwnedIds: desktopLiveSessionIds(),
    handOverFailedIds: handOverFailedIds(),
    // stopStates is the same injection again, and the only one that is not a
    // hint about a wait: it says which rows this server can actually signal,
    // so the Stop control is offered only where it would work.
    stopStates: stopStates(),
    projects,
    root,
    transcripts
  });
}
