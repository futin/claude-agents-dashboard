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
 *  - the turn is over (`idle`), or was cut short (`incomplete`) — never
 *    `working` (resuming would double-run it) or `question` (alive, waiting).
 *
 * The server re-checks liveness on POST (409) — the launch store for its own
 * children, a `ps` argv scan for everyone else's — so this gate is UX, not the
 * safety boundary.
 */
export function resumeEligible(
  session: Pick<Session, 'surface' | 'status' | 'stopState'>,
  holds: { question: boolean; plan: boolean; message: boolean },
  spawnAvailable: boolean | undefined
): boolean {
  if (spawnAvailable !== true) return false;
  if (session.surface !== 'dashboard') return false;
  if (holds.question || holds.plan || holds.message) return false;
  if (session.stopState) return false;
  return session.status === 'idle' || session.status === 'incomplete';
}
