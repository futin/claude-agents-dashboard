import { useCallback, useEffect, useRef, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import { useSettings } from './useSettings';
import type { AnswerRequest, PendingQuestion, QuestionAnswer, SessionQuestion } from '../../../shared/types';

/**
 * idle       — nothing submitted for the current question
 * submitting — a POST is in flight
 * submitted  — accepted; the session has the answer (banner until the entry clears)
 * gone       — the question ended without us: answered in the terminal, expired,
 *              or another tab got there first
 */
export type QuestionPhase = 'idle' | 'submitting' | 'submitted' | 'gone';

export interface PendingQuestionState {
  pending: PendingQuestion | null;
  phase: QuestionPhase;
  /** What we sent, for the confirmation banner (labels per question). */
  sentLabels: string[];
  /** Set when the server refused the token — the panel prompts for one. */
  needsToken: boolean;
  submit: (answers: QuestionAnswer[]) => Promise<void>;
  /** Hand the question back to the terminal dialog. */
  dismiss: () => Promise<void>;
  setToken: (t: string) => void;
}

/**
 * Poll `/api/sessions/:id/question` while the drawer is open and post the user's
 * pick back. Nothing here reads the transcript — the pending store already holds
 * the questions as structured data, straight from the hook's stdin.
 *
 * The poll is also how the panel disappears: any resolution (answered here or in
 * the terminal, expired, hook gone) empties the store, so `pending` goes null.
 */
export function usePendingQuestion(id: string): PendingQuestionState {
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  const [phase, setPhase] = useState<QuestionPhase>('idle');
  const [sentLabels, setSentLabels] = useState<string[]>([]);
  const [needsToken, setNeedsToken] = useState(false);
  // Only used when the server runs with ANSWER_TOKEN set.
  const [token, setToken] = usePersistedState<string>('dashboard.answerToken', '');
  const { settings: { refreshMs } } = useSettings();

  /** questionId the current phase refers to — a new question resets the panel. */
  const phaseFor = useRef<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Kept separate from the poll below: retuning the refresh rate restarts the
  // interval, and it must not wipe the panel of a question already on screen.
  useEffect(() => {
    setPending(null);
    setPhase('idle');
    setSentLabels([]);
    phaseFor.current = null;
  }, [id]);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      let body: SessionQuestion | null = null;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/question`);
        body = (await res.json()) as SessionQuestion;
      } catch {
        return; // keep the last snapshot; the next tick retries
      }
      if (!live || !body || body.error) return;

      const next = body.pending;
      setPending(next);
      if (!next) {
        // The wait is over. Keep a fresh "submitted" banner; otherwise reset.
        if (phaseFor.current !== null) {
          setPhase(cur => (cur === 'submitted' ? cur : 'idle'));
        }
        return;
      }
      if (phaseFor.current !== next.questionId) {
        // A different question is waiting now — clear any stale banner/error.
        phaseFor.current = next.questionId;
        setPhase('idle');
        setSentLabels([]);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  const post = useCallback(async (body: AnswerRequest): Promise<'ok' | 'gone' | 'token' | 'error'> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenRef.current) headers.Authorization = `Bearer ${tokenRef.current}`;
    let status = 0;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/answer`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      status = res.status;
    } catch {
      return 'error';
    }
    if (status === 200) return 'ok';
    if (status === 403) return 'token';
    // 404 (nothing waiting) and 409 (a different question now) both mean the
    // question we were looking at is no longer answerable.
    if (status === 404 || status === 409) return 'gone';
    return 'error';
  }, [id]);

  const submit = useCallback(async (answers: QuestionAnswer[]) => {
    const current = pending;
    if (!current || phase === 'submitting') return;
    setPhase('submitting');
    const outcome = await post({ questionId: current.questionId, answers });
    if (outcome === 'ok') {
      setNeedsToken(false);
      setSentLabels(answers.map(a => a.selected.join(', ')));
      setPhase('submitted');
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
    const outcome = await post({ questionId: current.questionId, dismiss: true });
    if (outcome === 'token') setNeedsToken(true);
    // Either way the panel goes away: dismissed here, or already over.
    setPhase(outcome === 'ok' ? 'idle' : outcome === 'gone' ? 'gone' : 'idle');
    if (outcome === 'ok') setPending(null);
  }, [pending, phase, post]);

  return { pending, phase, sentLabels, needsToken, submit, dismiss, setToken };
}
