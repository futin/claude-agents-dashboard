/**
 * triage.ts — the three piles the board and triage views sort sessions into.
 *
 * Pure, so the grouping can be tested without a DOM, and shared so the two
 * views that draw columns for it cannot disagree about which pile a session
 * belongs in.
 */

import type { Session } from '../../../shared/types';
import { holdKind } from './holds';

export interface TriageGroups {
  /** Waiting on a human: a held question, plan, reply window or permission dialog — or a terminal question the hook did not catch. */
  needs: Session[];
  /** Working, and blocked on nothing. */
  working: Session[];
  /** Idle or pending — nothing to watch right now. */
  quiet: Session[];
}

/**
 * Partition `sessions` into the three groups, preserving input order inside
 * each. Every session lands in exactly one: a hold outranks the status, so a
 * working session with a permission dialog open sits under *Needs you*, not
 * *Working*. `status === 'question'` counts as a need even with no remote hold —
 * the terminal is asking, the dashboard just cannot answer it.
 */
export function triageGroups(sessions: readonly Session[]): TriageGroups {
  const needs: Session[] = [];
  const working: Session[] = [];
  const quiet: Session[] = [];
  for (const s of sessions) {
    if (holdKind(s) || s.status === 'question') needs.push(s);
    else if (s.status === 'working') working.push(s);
    else quiet.push(s);
  }
  return { needs, working, quiet };
}
