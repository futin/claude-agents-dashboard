/**
 * messages.ts — the turn-end reply-window store behind remote messages.
 *
 * A session's Stop hook POSTs to `/api/messages/wait` when a turn finishes
 * while you are away, and the HTTP response is held open. The browser sees the
 * window, you type a follow-up in the chat drawer, and that resolves the held
 * response — the hook then blocks the stop with your text as the reason, which
 * the model reads and continues with. No reply → the hook exits 0 and the
 * session stops exactly as it did before this existed.
 *
 * Everything is in memory: a restart drops every hold and the sessions stop.
 *
 * Third parallel store, same state machine as `pending.ts`/`plans.ts` (same
 * injected `resolve`, same one-entry-per-session rule), separate module for the
 * same reason `plans.ts` is: the payloads and verdicts share nothing.
 *
 * See `docs/subsystems/remote-message.md`.
 */

import { randomUUID } from 'node:crypto';

import { wrapRemoteMessage } from './remote-message-prose.js';
import { createWaitStore, type WaitEntry } from './wait-store.js';
import type { MessageAnswerRequest, MessageWaitResult, PendingMessage } from '../../shared/types.js';

/** Cap on the follow-up that reaches the model verbatim. */
export const TEXT_CAP = 4000;

/** How a submitted answer was judged. Mirrors `plans.ts`'s outcome union. */
export type MessageOutcome = 'ok' | 'not-found' | 'mismatch' | 'malformed';

interface Entry extends WaitEntry<MessageWaitResult> {
  messageId: string;
  askedAt: string;
  expiresAt: string;
  /**
   * The session runs headless (`claude -p`, the dashboard `+ New` path) — no
   * terminal exists, so "back at the keyboard" gives the user no other way to
   * reply. The idle sweep skips these; only the deadline, an answer, a dismiss,
   * or a supersede ends them.
   */
  headless: boolean;
}

const store = createWaitStore<Entry, MessageWaitResult>({
  superseded: { status: 'superseded' },
  released: { status: 'released' },
  // The headless exemption — see {@link sweepIdle}: a `claude -p` session has no terminal to come back to, so the dashboard window stays its only channel.
  releasable: entry => !entry.headless
});

/**
 * The prose the hook prints as the Stop block's `reason`. Two jobs: carry the
 * text, and carry the away-mode instructions — `UserPromptSubmit` hooks (the
 * remote-decision injection) do NOT fire on hook-continued turns, so this is
 * the only place the reminder can ride.
 *
 * The wording, and its unwrapping back in `chat.ts`, live in `remote-message-prose.ts`.
 */
export function composeReason(text: string): string {
  return wrapRemoteMessage(text);
}

/**
 * Register a reply window and take ownership of the caller's held response.
 * Returns the `messageId` the browser must echo when sending.
 *
 * An existing entry for the session is superseded — a retried or duplicated
 * hook releases the older waiter rather than leaking it.
 */
export function register(
  sessionId: string,
  timeoutMs: number,
  resolve: (r: MessageWaitResult) => void,
  headless = false
): string {
  const messageId = randomUUID();
  const now = Date.now();
  const entry: Entry = {
    messageId,
    sessionId,
    askedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    timer: setTimeout(() => store.settle(entry, { status: 'timeout' }), timeoutMs),
    headless,
    resolve
  };
  store.add(entry);
  return messageId;
}

/** The reply window a session is holding, or null. */
export function getPendingMessage(sessionId: string): PendingMessage | null {
  const entry = store.get(sessionId);
  if (!entry) return null;
  return { messageId: entry.messageId, askedAt: entry.askedAt, expiresAt: entry.expiresAt };
}

/**
 * Every session holding a reply window right now. Read by the session scan so
 * the row can show `reply?`. A fresh Set: callers never get the store's keys.
 */
export function messageSessionIds(): Set<string> {
  return store.sessionIds();
}

/**
 * Deliver the user's follow-up (or `dismiss: true` to let the session stop
 * now). Synchronous by design, same as `pending.answer`: two tabs racing means
 * the first wins and the second sees `not-found`, with no locking.
 */
export function answer(sessionId: string, body: unknown): MessageOutcome {
  const entry = store.get(sessionId);
  if (!entry) return 'not-found';

  const req = body as MessageAnswerRequest | null;
  if (!req || typeof req !== 'object' || typeof req.messageId !== 'string') return 'malformed';
  if (req.messageId !== entry.messageId) return 'mismatch';

  if (req.dismiss === true) {
    store.settle(entry, { status: 'dismissed' });
    return 'ok';
  }

  const text = typeof req.text === 'string' ? req.text.slice(0, TEXT_CAP) : '';
  if (!text.trim()) return 'malformed';

  store.settle(entry, { status: 'answered', reason: composeReason(text) });
  return 'ok';
}

/**
 * Drop a hold whose peer is gone (the hook's socket closed — session
 * interrupted, hook killed, CLI hook timeout). No `resolve`: nobody is left to
 * answer to. A stale `messageId` is a no-op, so a late close can't evict a
 * newer entry.
 */
export function cancel(sessionId: string, messageId: string): void {
  store.cancel(sessionId, entry => entry.messageId === messageId);
}

/**
 * Release every hold — the sessions stop normally. Used when the remote-answer
 * toggle switches off, alongside the question and plan `dismissAll()`s.
 * Returns how many were released.
 */
export function dismissAll(): number {
  const waiting = store.values();
  for (const entry of waiting) store.settle(entry, { status: 'dismissed' });
  return waiting.length;
}

/** Test seam: drop every entry without resolving. */
export function resetStore(): void {
  store.reset();
}

/* ------------------------------------------------- idle auto-release */

/**
 * Release every terminal-backed hold if the user is back at the keyboard.
 * Returns how many. Headless holds are skipped: coming back to the desk gives
 * their sessions no terminal to type into, so the dashboard window stays the
 * only channel and stays open until answered, dismissed, or timed out. That
 * exemption is what makes this sweep differ from `pending.ts`/`plans.ts`, which
 * release everything.
 *
 * The fail directions (unreadable idle, `idleSecs === 0`) live in
 * {@link backAtDesk}, shared with the other two stores.
 *
 * The same release runs every 5 s from the one reaper `wait-store.ts` keeps for all three stores, which asks {@link backAtDesk} once per tick, not once per store.
 */
export function sweepIdle(): number {
  return store.sweepIdle();
}

