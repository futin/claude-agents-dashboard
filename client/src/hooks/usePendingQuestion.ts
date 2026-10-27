import { useCallback, useState } from 'react';

import { usePendingReply } from './usePendingReply';
import type { AnswerRequest, PendingQuestion, QuestionAnswer } from '../../../shared/types';

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
  const [sentLabels, setSentLabels] = useState<string[]>([]);
  const clearLabels = useCallback(() => setSentLabels([]), []);
  const reply = usePendingReply<PendingQuestion, 'submitted'>({
    id, pollPath: 'question', answerPath: 'answer', idOf: q => q.questionId, sentPhase: 'submitted', onFresh: clearLabels
  });
  const { send, dismiss: drop } = reply;

  const submit = useCallback((answers: QuestionAnswer[]) => send(
    (q): AnswerRequest => ({ questionId: q.questionId, answers }),
    { onOk: () => setSentLabels(answers.map(a => a.selected.join(', '))) }
  ), [send]);

  const dismiss = useCallback(() => drop((q): AnswerRequest => ({ questionId: q.questionId, dismiss: true })), [drop]);

  const { pending, phase, needsToken, readOnly, setToken } = reply;
  return { pending, phase, sentLabels, needsToken, readOnly, submit, dismiss, setToken };
}
