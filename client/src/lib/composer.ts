/**
 * composer.ts — the chat drawer composers' keyboard, shaped after the Desktop app's: Enter sends, Shift+Enter breaks the line, and Tab in an empty box
 * takes the suggested reply. Pure — `test/composer.test.ts`.
 *
 * The suggestion is the session's own: the first next-step button of its last `wrap_up` call (`suggestion` on that tool line, `server/lib/chat.ts`).
 * Only Desktop sessions call wrap_up, so a CLI session simply never has one.
 */

import type { ChatMessage } from '../../../shared/types';

/**
 * A phone or tablet: a finger for the primary pointer — the same test styles.css's `@media (pointer:coarse)` makes. Its soft keyboard has no
 * Shift+Enter, so there Enter keeps breaking the line and the send button sends. A touchscreen laptop still reports a fine primary pointer, so it gets
 * the desktop keys.
 */
export const TOUCH_QUERY = '(pointer: coarse)';

/**
 * The newest wrap_up suggestion of the turn the session is waiting on, or null. The walk stops at the first user message from the end: anything past
 * it belongs to a turn that was already answered.
 */
export function latestSuggestion(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return null;
    for (let j = m.tools.length - 1; j >= 0; j--) {
      const s = m.tools[j].suggestion;
      if (s) return s;
    }
  }
  return null;
}

/** The parts of a keydown the decision reads — a React or a DOM event both fit. */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** An IME is mid-composition: its Enter commits the candidate, it must never send. */
  isComposing: boolean;
}

export type ComposerKey = 'send' | 'accept' | null;

/**
 * What a keydown in a composer does. `send` and `accept` mean the caller prevents the default; null leaves the browser's own behaviour — a newline, a
 * focus move. `send` is the intent only: whether there is text to send is the caller's guard, the same one its send button has.
 */
export function composerKey(
  e: ComposerKeyEvent,
  ctx: { touch: boolean; empty: boolean; suggestion: string | null }
): ComposerKey {
  if (e.isComposing) return null;
  if (e.key === 'Enter') return e.shiftKey || e.altKey || ctx.touch ? null : 'send';
  if (e.key === 'Tab') {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
    return ctx.empty && ctx.suggestion ? 'accept' : null;
  }
  return null;
}
