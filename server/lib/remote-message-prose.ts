/**
 * remote-message-prose.ts — the one owner of the wrapper around a follow-up typed into the chat drawer.
 *
 * `messages.ts` wraps the text on the way into the session, `chat.ts` unwraps the transcript record on the way back out; both derive from the two
 * constants below, so the directions cannot drift apart. The module imports nothing, which keeps the read path (`chat.ts`) free of the reply-window
 * store. The wording is frozen by every transcript already on disk: change it and past follow-ups stop unwrapping (`docs/subsystems/remote-message.md`).
 */

export const REMOTE_MESSAGE_HEAD =
  'The user is away from the terminal and sent this follow-up from the dashboard; treat it as their next message:\n';

export const REMOTE_MESSAGE_TAIL =
  '\n\nContinue working on it now. The user is still away: put any decision through the AskUserQuestion tool, never end the turn on a prose '
  + 'question, and prefer already-permitted tools — a permission dialog would park the session until they return.';

function escapeRegExp(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

// The CLI records the Stop block under a `Stop hook feedback:` line; both ends are anchored so a near-miss fails closed.
const MATCHER = new RegExp(
  '^(?:Stop hook feedback:\\n)?' + escapeRegExp(REMOTE_MESSAGE_HEAD) + '([\\s\\S]*)' + escapeRegExp(REMOTE_MESSAGE_TAIL) + '\\s*$'
);

/** The `reason` a remote follow-up is sent with: the trimmed text inside the away-mode instructions. */
export function wrapRemoteMessage(text: string): string {
  return REMOTE_MESSAGE_HEAD + text.trim() + REMOTE_MESSAGE_TAIL;
}

/** The text the user actually typed, or null if this isn't a remote follow-up. */
export function unwrapRemoteMessage(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const text = MATCHER.exec(content)?.[1].trim();
  return text ? text : null;
}
