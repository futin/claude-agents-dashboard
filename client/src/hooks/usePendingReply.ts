import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { useSettings } from './useSettings';
import { postWrite } from '../lib/postWrite';
import { afterDismiss, afterPoll, afterSend, canSend, replyOutcome } from '../lib/pendingReply';
import type { ReplyOutcome, ReplyPatch, ReplyPhase } from '../lib/pendingReply';

export interface PendingReplyOptions<T, S extends string> {
  /** The session the drawer shows. */
  id: string;
  /** `/api/sessions/:id/<pollPath>` answers `{ pending, error? }`. */
  pollPath: string;
  /** `/api/sessions/:id/<answerPath>` takes the reply. */
  answerPath: string;
  /** The pending entry's own id — a new one resets the panel. */
  idOf: (pending: T) => string;
  /** This panel's name for the accepted phase. */
  sentPhase: S;
  /** Called when the panel resets: a new session id, or a new reply id replacing the old one. */
  onFresh?: () => void;
}

export interface PendingReplyControl<T, S extends string> {
  pending: T | null;
  phase: ReplyPhase<S>;
  needsToken: boolean;
  readOnly: boolean;
  setToken: (t: string) => void;
  /**
   * Post `bodyOf(pending)` as the reply. A no-op unless `canSend(pending, phase, text)`; leave `text` out to skip the blank check. `onOk` runs on success,
   * in the same update as the accepted phase.
   */
  send: <B>(bodyOf: (pending: T) => B, opts?: { text?: string; onOk?: () => void }) => Promise<void>;
  /** Post `bodyOf(pending)` as a dismissal. */
  dismiss: <B>(bodyOf: (pending: T) => B) => Promise<void>;
}

/**
 * The poll-and-reply loop behind `usePendingQuestion`, `usePendingPlan` and `usePendingMessage`. Polls the pending store while the drawer is open and posts
 * the user's reply back; every decision is `lib/pendingReply.ts`'s, so this holds only the React state and the requests.
 *
 * The poll is also how a panel disappears: any resolution (answered here or in the terminal, expired, hook gone) empties the store, so `pending` goes null.
 */
export function usePendingReply<T, S extends string>(
  { id, pollPath, answerPath, idOf, sentPhase, onFresh }: PendingReplyOptions<T, S>
): PendingReplyControl<T, S> {
  const [pending, setPending] = useState<T | null>(null);
  const [phase, setPhase] = useState<ReplyPhase<S>>('idle');
  const [needsToken, setNeedsToken] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  // Only used when the write gate wants a token from this browser (a LAN client, a container, tailnet trust off). One token for all three panels.
  const [token, setToken] = useAnswerToken();
  const { settings: { refreshMs } } = useSettings();

  /** The reply id the current phase refers to. */
  const phaseFor = useRef<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // Refs, so a caller passing fresh closures each render does not restart the poll.
  const idOfRef = useRef(idOf);
  idOfRef.current = idOf;
  const onFreshRef = useRef(onFresh);
  onFreshRef.current = onFresh;

  // Kept separate from the poll below: retuning the refresh rate restarts the
  // interval, and it must not wipe the panel of a reply already on screen.
  useEffect(() => {
    setPending(null);
    setPhase('idle');
    onFreshRef.current?.();
    phaseFor.current = null;
  }, [id]);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      let body: { pending: T | null; error?: boolean } | null = null;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${pollPath}`);
        body = (await res.json()) as { pending: T | null; error?: boolean };
      } catch {
        return; // keep the last snapshot; the next tick retries
      }
      if (!live || !body || body.error) return;

      const next = body.pending;
      setPending(next);
      const before = phaseFor.current;
      const nextId = next ? idOfRef.current(next) : null;
      const step = afterPoll(before, nextId, 'idle', sentPhase);
      phaseFor.current = step.phaseFor;
      setPhase(cur => afterPoll(before, nextId, cur, sentPhase).phase);
      if (step.fresh) onFreshRef.current?.();
    }

    void poll();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, pollPath, sentPhase, refreshMs]);

  const apply = useCallback((patch: ReplyPatch<S>) => {
    if (patch.needsToken !== undefined) setNeedsToken(patch.needsToken);
    if (patch.readOnly !== undefined) setReadOnly(patch.readOnly);
    setPhase(patch.phase);
    if (patch.clearPending) setPending(null);
  }, []);

  const post = useCallback(async (body: unknown): Promise<ReplyOutcome> => {
    const result = await postWrite(`/api/sessions/${encodeURIComponent(id)}/${answerPath}`, { token: tokenRef.current, body });
    return replyOutcome(result);
  }, [id, answerPath]);

  const send = useCallback(async <B>(bodyOf: (pending: T) => B, opts: { text?: string; onOk?: () => void } = {}): Promise<void> => {
    const current = pending;
    if (!current || !canSend(current, phase, opts.text)) return;
    setPhase('submitting');
    const outcome = await post(bodyOf(current));
    if (outcome === 'ok') opts.onOk?.();
    apply(afterSend(outcome, sentPhase));
  }, [pending, phase, post, apply, sentPhase]);

  const dismiss = useCallback(async <B>(bodyOf: (pending: T) => B): Promise<void> => {
    const current = pending;
    if (!current || !canSend(current, phase)) return;
    setPhase('submitting');
    apply(afterDismiss(await post(bodyOf(current))));
  }, [pending, phase, post, apply]);

  return { pending, phase, needsToken, readOnly, setToken, send, dismiss };
}
