/**
 * holds.ts — which hold a session is in, and how many rows are holding.
 *
 * The precedence below used to live only inside the session row's `chatTab`. Two
 * other readers want the same answer now — the header's "need you" count and
 * the browser-notification gate — so it lives here instead of being restated
 * where it could drift.
 *
 * See `docs/subsystems/settings.md`.
 */

import type { Session } from '../../../shared/types';

/** The four things a session can be waiting on a human for. */
export type HoldKind = 'question' | 'plan' | 'reply' | 'permission';

/**
 * What this session is waiting on, nearest-to-blocked first: a held question
 * outranks a held plan, which outranks an open reply window, which outranks a
 * terminal permission dialog. `null` means nothing is waiting on you.
 */
export function holdKind(s: Session): HoldKind | null {
  if (s.remoteQuestion) return 'question';
  if (s.remotePlan) return 'plan';
  if (s.remoteReply) return 'reply';
  if (s.permissionWait) return 'permission';
  return null;
}

/** How many of these rows are waiting on you — every surface, every kind. */
export function holdCount(sessions: readonly Session[]): number {
  let n = 0;
  for (const s of sessions) if (holdKind(s)) n++;
  return n;
}

/** What the chat button says, and how it is tinted. */
export interface ChatTab {
  label: string;
  /** '' = the plain steel button; the two tones name who can act. */
  tone: '' | 'answer' | 'permission';
  title: string;
}

const HOLD_TABS: Record<HoldKind, ChatTab> = {
  question: { label: 'answer', tone: 'answer', title: 'A question is waiting on you — answer it in the chat drawer' },
  plan: { label: 'plan?', tone: 'answer', title: 'A plan is waiting — revise it from the chat drawer, or approve it in that terminal' },
  reply: { label: 'reply?', tone: 'answer', title: 'Turn finished — reply from the chat drawer, or let it stop' },
  permission: { label: 'allow?', tone: 'permission', title: 'Claude is waiting for permission — answer it in that terminal' }
};

const NO_HOLD_TAB: ChatTab = { label: 'chat', tone: '', title: 'Open chat history' };

/**
 * The one control every view draws for a session — the way into its chat
 * drawer, and the place it names a hold when it has one. Every hold routes to
 * the same drawer, so they share one button rather than competing as pills;
 * `permission` keeps its own tone because it can only be answered in that
 * terminal. Precedence is `holdKind`'s, shared with the header count and the
 * browser notifications.
 */
export function chatTab(s: Session): ChatTab {
  const kind = holdKind(s);
  return kind ? HOLD_TABS[kind] : NO_HOLD_TAB;
}
