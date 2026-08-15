import { useCallback, useEffect, useRef, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import { useSettings } from './useSettings';
import type { PendingPlan, PlanAnswerRequest, SessionPlan } from '../../../shared/types';

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
  const [pending, setPending] = useState<PendingPlan | null>(null);
  const [phase, setPhase] = useState<PlanPhase>('idle');
  const [needsToken, setNeedsToken] = useState(false);
  // Shared with the question panel — one dashboard, one token.
  const [token, setToken] = usePersistedState<string>('dashboard.answerToken', '');
  const { settings: { refreshMs } } = useSettings();

  /** planId the current phase refers to — a new plan resets the panel. */
  const phaseFor = useRef<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Kept separate from the poll below: retuning the refresh rate restarts the
  // interval, and it must not wipe the panel of a plan already on screen.
  useEffect(() => {
    setPending(null);
    setPhase('idle');
    phaseFor.current = null;
  }, [id]);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      let body: SessionPlan | null = null;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/plan`);
        body = (await res.json()) as SessionPlan;
      } catch {
        return; // keep the last snapshot; the next tick retries
      }
      if (!live || !body || body.error) return;

      const next = body.pending;
      setPending(next);
      if (!next) {
        // The wait is over. Keep a fresh "sent" banner; otherwise reset.
        if (phaseFor.current !== null) setPhase(cur => (cur === 'sent' ? cur : 'idle'));
        return;
      }
      if (phaseFor.current !== next.planId) {
        // A revised plan is waiting now — clear any stale banner/error.
        phaseFor.current = next.planId;
        setPhase('idle');
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  const post = useCallback(async (body: PlanAnswerRequest): Promise<'ok' | 'gone' | 'token' | 'error'> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenRef.current) headers.Authorization = `Bearer ${tokenRef.current}`;
    let status = 0;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/plan-answer`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      status = res.status;
    } catch {
      return 'error';
    }
    if (status === 200) return 'ok';
    if (status === 403) return 'token';
    // 404 (nothing waiting) and 409 (a newer plan now) both mean the plan we
    // were looking at is no longer answerable.
    if (status === 404 || status === 409) return 'gone';
    return 'error';
  }, [id]);

  const reject = useCallback(async (feedback: string) => {
    const current = pending;
    if (!current || phase === 'submitting' || !feedback.trim()) return;
    setPhase('submitting');
    const outcome = await post({ planId: current.planId, verdict: 'reject', feedback });
    if (outcome === 'ok') {
      setNeedsToken(false);
      setPhase('sent');
    } else if (outcome === 'token') {
      setNeedsToken(true);
      setPhase('idle');
    } else if (outcome === 'gone') {
      setPhase('gone');
    } else {
      setPhase('idle');
    }
  }, [pending, phase, post]);

  const dismiss = useCallback(async () => {
    const current = pending;
    if (!current || phase === 'submitting') return;
    setPhase('submitting');
    const outcome = await post({ planId: current.planId, verdict: 'dismiss' });
    if (outcome === 'token') setNeedsToken(true);
    setPhase(outcome === 'gone' ? 'gone' : 'idle');
    if (outcome === 'ok') setPending(null);
  }, [pending, phase, post]);

  return { pending, phase, needsToken, reject, dismiss, setToken };
}
