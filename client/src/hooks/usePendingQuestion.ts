import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { authHeaders } from '../lib/answerToken';
import { useSettings } from './useSettings';
import { refusalKind } from '../lib/writeRefusal';
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
  /** Set when the server says this network is read-only: no token can help, so the panel says so instead of prompting. */
  readOnly: boolean;
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
  const [readOnly, setReadOnly] = useState(false);
  // Only used when the write gate wants a token from this browser (a LAN client, a container, tailnet trust off).
  const [token, setToken] = useAnswerToken();
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

  const post = useCallback(async (body: AnswerRequest): Promise<'ok' | 'gone' | 'token' | 'read-only' | 'error'> => {
    const headers = authHeaders(tokenRef.current, { 'Content-Type': 'application/json' });
    let status = 0;
    let refusal: unknown;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/answer`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      status = res.status;
      if (status === 403) refusal = await res.json().catch(() => undefined);
    } catch {
      return 'error';
    }
    if (status === 200) return 'ok';
    if (status === 403) return refusalKind(status, refusal) === 'read-only' ? 'read-only' : 'token';
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
      setReadOnly(false);
      setSentLabels(answers.map(a => a.selected.join(', ')));
      setPhase('submitted');
    } else if (outcome === 'token') {
      setNeedsToken(true);
      setReadOnly(false);
      setPhase('idle');
    } else if (outcome === 'read-only') {
      setReadOnly(true);
      setNeedsToken(false);
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
    if (outcome === 'read-only') setReadOnly(true);
    // Either way the panel goes away: dismissed here, or already over.
    setPhase(outcome === 'ok' ? 'idle' : outcome === 'gone' ? 'gone' : 'idle');
    if (outcome === 'ok') setPending(null);
  }, [pending, phase, post]);

  return { pending, phase, sentLabels, needsToken, readOnly, submit, dismiss, setToken };
}
