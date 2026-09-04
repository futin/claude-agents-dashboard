/**
 * holds.ts — which hold a session is in, and how many rows are holding.
 *
 * The precedence below used to live only inside `SessionRow`'s `chatTab`. Two
 * other readers want the same answer now — the header's "need you" count and
 * the browser-notification gate — so it lives here instead of being restated
 * where it could drift.
 *
 * See `docs/subsystems/settings.md`.
 */

import type { Session } from '../../../shared/types';

/** The four things a session can be waiting on a human for. */
export type HoldKind = 'question' | 'plan' | 'reply' | 'permission';

/**
 * What this session is waiting on, nearest-to-blocked first: a held question
 * outranks a held plan, which outranks an open reply window, which outranks a
 * terminal permission dialog. `null` means nothing is waiting on you.
 */
export function holdKind(s: Session): HoldKind | null {
  if (s.remoteQuestion) return 'question';
  if (s.remotePlan) return 'plan';
  if (s.remoteReply) return 'reply';
  if (s.permissionWait) return 'permission';
  return null;
}

/** How many of these rows are waiting on you — every surface, every kind. */
export function holdCount(sessions: readonly Session[]): number {
  let n = 0;
  for (const s of sessions) if (holdKind(s)) n++;
  return n;
}
