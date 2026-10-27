import { useCallback } from 'react';

import { usePendingReply } from './usePendingReply';
import type { PendingPlan, PlanAnswerRequest } from '../../../shared/types';

/**
 * idle       — nothing sent for the current plan
 * submitting — a POST is in flight
 * sent       — accepted; the model has the feedback (banner until the entry clears)
 * gone       — the plan ended without us: answered on the card, expired, or
 *              another tab got there first
 */
export type PlanPhase = 'idle' | 'submitting' | 'sent' | 'gone';

export interface PendingPlanState {
  pending: PendingPlan | null;
  phase: PlanPhase;
  /** Set when the server refused the token — the panel prompts for one. */
  needsToken: boolean;
  /** Set when the server says this network is read-only: no token can help, so the panel says so instead of prompting. */
  readOnly: boolean;
  /** Send the plan back for revision. Feedback is required — see plans.ts. */
  reject: (feedback: string) => Promise<void>;
  /** Hand the plan back to its card in the terminal. */
  dismiss: () => Promise<void>;
  setToken: (t: string) => void;
}

/**
 * Poll `/api/sessions/:id/plan` while the drawer is open and post a verdict back.
 * Same shape as {@link usePendingQuestion}; the plan store holds the markdown
 * straight from the hook's stdin, so nothing here re-parses the transcript.
 *
 * There is no `accept`: the CLI discards a hook `allow` for `ExitPlanMode`, so
 * approving is only ever possible on the card itself.
 */
export function usePendingPlan(id: string): PendingPlanState {
  const reply = usePendingReply<PendingPlan, 'sent'>({ id, pollPath: 'plan', answerPath: 'plan-answer', idOf: p => p.planId, sentPhase: 'sent' });
  const { send, dismiss: drop } = reply;

  const reject = useCallback((feedback: string) => send(
    (p): PlanAnswerRequest => ({ planId: p.planId, verdict: 'reject', feedback }), { text: feedback }
  ), [send]);

  const dismiss = useCallback(() => drop((p): PlanAnswerRequest => ({ planId: p.planId, verdict: 'dismiss' })), [drop]);

  const { pending, phase, needsToken, readOnly, setToken } = reply;
  return { pending, phase, needsToken, readOnly, reject, dismiss, setToken };
}
