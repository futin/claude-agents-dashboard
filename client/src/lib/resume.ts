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
 *  - the turn is over (`idle`), or was cut short (`incomplete`) — never
 *    `working` (resuming would double-run it) or `question` (alive, waiting).
 *
 * The server re-checks liveness on POST (409), so this gate is UX, not the
 * safety boundary.
 */
export function resumeEligible(
  session: Pick<Session, 'surface' | 'status'>,
  holds: { question: boolean; plan: boolean; message: boolean },
  spawnAvailable: boolean | undefined
): boolean {
  if (spawnAvailable !== true) return false;
  if (session.surface !== 'dashboard') return false;
  if (holds.question || holds.plan || holds.message) return false;
  return session.status === 'idle' || session.status === 'incomplete';
}
