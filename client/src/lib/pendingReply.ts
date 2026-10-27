/**
 * pendingReply.ts — the state machine the three chat-drawer reply panels share (question, plan, message). Apart from React so a node test can pin every
 * transition; `hooks/usePendingReply.ts` holds the React state and applies what these return.
 *
 * Each panel names its "accepted" phase itself — `submitted` for a question, `sent` for a plan or a message — so every function that can land there takes
 * that name as `sent`, and the panels' own phase types stay as they were.
 */

import type { WriteResult } from './postWrite';

export type ReplyOutcome = 'ok' | 'gone' | 'token' | 'read-only' | 'error';

/** A panel's phase: `S` is its own name for the accepted phase. */
export type ReplyPhase<S extends string> = 'idle' | 'submitting' | S | 'gone';

/** What a send or a dismiss changes. A key left out means "leave as is". */
export interface ReplyPatch<S extends string> {
  phase: ReplyPhase<S>;
  needsToken?: boolean;
  readOnly?: boolean;
  /** The reply is over here: drop `pending` without waiting for the next poll. */
  clearPending?: boolean;
}

/** How one answer POST ended. 404 (nothing waiting) and 409 (a newer one now) both mean the reply on screen is no longer answerable. */
export function replyOutcome(result: WriteResult): ReplyOutcome {
  if (result.status === 200) return 'ok';
  if (result.refusal === 'read-only') return 'read-only';
  if (result.refusal === 'token') return 'token';
  if (result.status === 404 || result.status === 409) return 'gone';
  return 'error';
}

/** After a send: success clears both flags, and each refusal sets its own flag and clears the other. */
export function afterSend<S extends string>(outcome: ReplyOutcome, sent: S): ReplyPatch<S> {
  switch (outcome) {
    case 'ok': return { phase: sent, needsToken: false, readOnly: false };
    case 'token': return { phase: 'idle', needsToken: true, readOnly: false };
    case 'read-only': return { phase: 'idle', readOnly: true, needsToken: false };
    case 'gone': return { phase: 'gone' };
    default: return { phase: 'idle' };
  }
}

/**
 * After a dismiss: either way the panel goes away, dismissed here or already over. Unlike `afterSend`, a refusal sets only its own flag and leaves the
 * other as it was, and a success touches neither.
 */
export function afterDismiss(outcome: ReplyOutcome): ReplyPatch<never> {
  switch (outcome) {
    case 'ok': return { phase: 'idle', clearPending: true };
    case 'token': return { phase: 'idle', needsToken: true };
    case 'read-only': return { phase: 'idle', readOnly: true };
    case 'gone': return { phase: 'gone' };
    default: return { phase: 'idle' };
  }
}

/**
 * After a poll answered. `phaseFor` is the reply id the current phase refers to, `nextId` the one waiting now (null when none is). When the wait is over a
 * fresh accepted banner stays and anything else resets; a different id waiting resets the panel, and `fresh` says so.
 */
export function afterPoll<S extends string>(
  phaseFor: string | null, nextId: string | null, phase: ReplyPhase<S>, sent: S
): { phaseFor: string | null; phase: ReplyPhase<S>; fresh: boolean } {
  if (nextId === null) {
    return { phaseFor, phase: phaseFor !== null && phase !== sent ? 'idle' : phase, fresh: false };
  }
  if (phaseFor !== nextId) return { phaseFor: nextId, phase: 'idle', fresh: true };
  return { phaseFor, phase, fresh: false };
}

/** Whether a send or dismiss may start: something is pending, no POST is out, and `text`, when given, is not blank. */
export function canSend(pending: unknown, phase: string, text?: string): boolean {
  if (!pending || phase === 'submitting') return false;
  return text === undefined || text.trim() !== '';
}
