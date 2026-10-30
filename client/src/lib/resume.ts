import { DESKTOP_FAILED_TEXT } from './launchSurface';
import type { Session } from '../../../shared/types';

/**
 * Should the chat drawer offer the resume composer for this session?
 *
 * Pure — the drawer computes the inputs, this decides. Eligible means:
 *
 *  - spawn is actually available (strict `true`; an unknown health snapshot
 *    hides the composer rather than offering a button that can only 404),
 *  - the session is `dashboard`-surface — headless `claude -p`, the only kind
 *    `POST /api/spawn` will resume (terminal sessions stay terminal-owned),
 *  - nothing is pending: a held question, plan, or reply window means the
 *    process is alive, and its own panel is the composer to use,
 *  - no `stopState`: it is present only while this server holds a live child
 *    for the session, and resuming one would put a second writer on its
 *    transcript. `incomplete` stays eligible — it is the ordinary "your turn"
 *    state and the reason the feature exists — but a post-turn `claude -p`
 *    lingers (measured 90s+) reading `incomplete` the whole time, so status
 *    alone never meant the process was gone (`bug-19`).
 *  - no `processLive`: the server's `ps` scan found a live `claude` carrying this id that it holds no handle for (a restarted dashboard, an
 *    orchestrator or routine run, a pending background Monitor). The drawer shows a "still running" note in the composer's place instead.
 *  - the turn is over (`idle`), or was cut short (`incomplete`) — never
 *    `working` (resuming would double-run it) or `question` (alive, waiting).
 *
 *  - not `desktopOwned`: the desktop app holds the session, and `claude -p --resume` beside it would put a second writer on its transcript.
 *
 * The server re-checks liveness on POST (409) — the launch store for its own
 * children, a `ps` argv scan for everyone else's — so this gate is UX, not the
 * safety boundary.
 */
export function resumeEligible(
  session: Pick<Session, 'surface' | 'status' | 'stopState' | 'processLive' | 'desktopOwned'>,
  holds: { question: boolean; plan: boolean; message: boolean },
  spawnAvailable: boolean | undefined
): boolean {
  if (spawnAvailable !== true) return false;
  if (session.surface !== 'dashboard') return false;
  if (session.desktopOwned) return false;
  if (holds.question || holds.plan || holds.message) return false;
  if (session.stopState) return false;
  if (session.processLive) return false;
  return session.status === 'idle' || session.status === 'incomplete';
}

/**
 * What the drawer's "Open in desktop app" control does for this session. `hidden` unless the host can open the app (strict `true`, like `resumeEligible`)
 * and the session is a headless `dashboard` one — terminal and cloud sessions have no `claude -p` transcript to hand over. `owned` once the app already
 * holds it. Otherwise the same liveness facts that keep the resume composer away say `stop-first`, and so does every status but the two that mean the
 * turn is over: handing over a `working` or `question` session would open a second writer on a transcript still being written. The server re-checks
 * (409) — this is UX, not the safety boundary.
 */
export function handOverState(
  session: Pick<Session, 'surface' | 'status' | 'stopState' | 'processLive' | 'desktopOwned'>,
  holds: { question: boolean; plan: boolean; message: boolean },
  desktopAvailable: boolean | undefined
): 'hidden' | 'offer' | 'stop-first' | 'owned' {
  if (desktopAvailable !== true) return 'hidden';
  if (session.surface !== 'dashboard') return 'hidden';
  if (session.desktopOwned) return 'owned';
  if (holds.question || holds.plan || holds.message) return 'stop-first';
  if (session.stopState || session.processLive) return 'stop-first';
  return session.status === 'idle' || session.status === 'incomplete' ? 'offer' : 'stop-first';
}

/** A hand-over's failure as the line beside the button: the 500 `open failed` becomes the fixed copy, every other server text (409s) passes through. */
export function handOverErrorText(error: string): string {
  return error === 'open failed' ? DESKTOP_FAILED_TEXT : error;
}

/**
 * Should the drawer show the "still running" note where the resume composer would have been? True for the rows `resumeEligible` turns away only
 * because `processLive` says a process this server cannot stop still holds the session: `dashboard`, its turn over (`idle`/`incomplete`), nothing
 * held. Held panels and `working` already say the session is alive, so they get no second note.
 */
export function stillRunningNote(
  session: Pick<Session, 'surface' | 'status' | 'stopState' | 'processLive'>,
  holds: { question: boolean; plan: boolean; message: boolean }
): boolean {
  if (!session.processLive || session.stopState) return false;
  if (session.surface !== 'dashboard') return false;
  if (holds.question || holds.plan || holds.message) return false;
  return session.status === 'idle' || session.status === 'incomplete';
}

/** What the drawer says about a session whose process is still alive: the note's own text and the plain form of the server's 409. */
export const STILL_RUNNING_HINT = 'waiting on background work — resume once it exits';
export const STILL_RUNNING_DETAIL =
  'This session’s process is still running, so it cannot be resumed yet. This dashboard did not start it (or restarted since), so it cannot stop it from here. ' +
  'The composer comes back on its own once the process exits.';

/** The server's 409 for a live session, as the plain explanation; every other error passes through unchanged. */
export function resumeErrorText(error: string): string {
  return error === 'session is still running' ? STILL_RUNNING_DETAIL : error;
}
