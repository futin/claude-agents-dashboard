/**
 * heldBody.ts — which timeline body the chat drawer folds while a pinned panel shows the same thing.
 *
 * A held AskUserQuestion (or ExitPlanMode) renders twice: the pinned panel draws it from the pending store, and the tool_use record lands in the
 * transcript about a second into the hold, so the 3s tail draws it again as a `.cmsg-plan` body. The panel carries the controls, so it stays the full
 * rendering and the timeline copy folds until the hold ends (`docs/subsystems/remote-answer.md`).
 */

import type { ChatMessage } from '../../../shared/types';

export type HeldTool = 'AskUserQuestion' | 'ExitPlanMode';

/**
 * The `uuid` of the newest loaded message whose `tool` call carries a body, or null when nothing is held or no such message is loaded yet. Newest only:
 * earlier asks were already answered and stay expanded as history.
 */
export function heldBodyUuid(messages: ChatMessage[], tool: HeldTool, held: boolean): string | null {
  if (!held) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].tools.some(t => t.name === tool && !!t.body)) return messages[i].uuid;
  }
  return null;
}
