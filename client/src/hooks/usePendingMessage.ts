import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { authHeaders } from '../lib/answerToken';
import { useSettings } from './useSettings';
import { refusalKind } from '../lib/writeRefusal';
import type { MessageAnswerRequest, PendingMessage, SessionMessage } from '../../../shared/types';

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
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [phase, setPhase] = useState<MessagePhase>('idle');
  const [needsToken, setNeedsToken] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  // Shared with the question and plan panels — one dashboard, one token.
  const [token, setToken] = useAnswerToken();
  const { settings: { refreshMs } } = useSettings();

  /** messageId the current phase refers to — a new window resets the panel. */
  const phaseFor = useRef<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Kept separate from the poll below: retuning the refresh rate restarts the
  // interval, and it must not wipe the panel of a window already on screen.
  useEffect(() => {
    setPending(null);
    setPhase('idle');
    phaseFor.current = null;
  }, [id]);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      let body: SessionMessage | null = null;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/message`);
        body = (await res.json()) as SessionMessage;
      } catch {
        return; // keep the last snapshot; the next tick retries
      }
      if (!live || !body || body.error) return;

      const next = body.pending;
      setPending(next);
      if (!next) {
        // The window is over. Keep a fresh "sent" banner; otherwise reset.
        if (phaseFor.current !== null) setPhase(cur => (cur === 'sent' ? cur : 'idle'));
        return;
      }
      if (phaseFor.current !== next.messageId) {
        // A new turn ended — a fresh window replaces any stale banner/error.
        phaseFor.current = next.messageId;
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

  const post = useCallback(async (body: MessageAnswerRequest): Promise<'ok' | 'gone' | 'token' | 'read-only' | 'error'> => {
    const headers = authHeaders(tokenRef.current, { 'Content-Type': 'application/json' });
    let status = 0;
    let refusal: unknown;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/message-answer`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      status = res.status;
      if (status === 403) refusal = await res.json().catch(() => undefined);
    } catch {
      return 'error';
    }
    if (status === 200) return 'ok';
    if (status === 403) return refusalKind(status, refusal) === 'read-only' ? 'read-only' : 'token';
    // 404 (nothing open) and 409 (a newer window now) both mean the window we
    // were looking at is no longer answerable.
    if (status === 404 || status === 409) return 'gone';
    return 'error';
  }, [id]);

  const send = useCallback(async (text: string) => {
    const current = pending;
    if (!current || phase === 'submitting' || !text.trim()) return;
    setPhase('submitting');
    const outcome = await post({ messageId: current.messageId, text });
    if (outcome === 'ok') {
      setNeedsToken(false);
      setReadOnly(false);
      setPhase('sent');
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
    const outcome = await post({ messageId: current.messageId, dismiss: true });
    if (outcome === 'token') setNeedsToken(true);
    if (outcome === 'read-only') setReadOnly(true);
    setPhase(outcome === 'gone' ? 'gone' : 'idle');
    if (outcome === 'ok') setPending(null);
  }, [pending, phase, post]);

  return { pending, phase, needsToken, readOnly, send, dismiss, setToken };
}
