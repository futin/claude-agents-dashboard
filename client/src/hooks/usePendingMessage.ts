import { useCallback } from 'react';

import { usePendingReply } from './usePendingReply';
import type { MessageAnswerRequest, PendingMessage } from '../../../shared/types';

/**
 * idle       — nothing sent for the current window
 * submitting — a POST is in flight
 * sent       — accepted; the model is continuing with the follow-up
 * gone       — the window closed without us: expired, released (you came back
 *              to the keyboard), or another tab got there first
 */
export type MessagePhase = 'idle' | 'submitting' | 'sent' | 'gone';

export interface PendingMessageState {
  pending: PendingMessage | null;
  phase: MessagePhase;
  /** Set when the server refused the token — the panel prompts for one. */
  needsToken: boolean;
  /** Set when the server says this network is read-only: no token can help, so the panel says so instead of prompting. */
  readOnly: boolean;
  /** Continue the model with this follow-up. Text is required — see messages.ts. */
  send: (text: string) => Promise<void>;
  /** Release the hold: the session stops now instead of sitting out the window. */
  dismiss: () => Promise<void>;
  setToken: (t: string) => void;
}

/**
 * Poll `/api/sessions/:id/message` while the drawer is open and post a
 * follow-up back. Same shape as {@link usePendingPlan}; the window carries no
 * content of its own (the turn's last message is already in the transcript
 * above), so the panel is purely a composer.
 */
export function usePendingMessage(id: string): PendingMessageState {
  const reply = usePendingReply<PendingMessage, 'sent'>({
    id, pollPath: 'message', answerPath: 'message-answer', idOf: m => m.messageId, sentPhase: 'sent'
  });
  const { send: post, dismiss: drop } = reply;

  const send = useCallback((text: string) => post(
    (m): MessageAnswerRequest => ({ messageId: m.messageId, text }), { text }
  ), [post]);

  const dismiss = useCallback(() => drop((m): MessageAnswerRequest => ({ messageId: m.messageId, dismiss: true })), [drop]);

  const { pending, phase, needsToken, readOnly, setToken } = reply;
  return { pending, phase, needsToken, readOnly, send, dismiss, setToken };
}
