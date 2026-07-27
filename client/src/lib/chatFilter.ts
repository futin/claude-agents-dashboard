/**
 * chatFilter.ts — which messages the chat drawer shows.
 *
 * A transcript is mostly tool traffic: dozens of near-identical one-liners
 * ("Edit <path>", "Bash …") between the few turns that actually say what's
 * going on. Filtering is client-side and pure, so switching is instant and
 * keeps every page already loaded.
 */

import type { ChatMessage } from '../../../shared/types';

export type ChatFilter = 'all' | 'text' | 'prompts';

export const CHAT_FILTERS: { key: ChatFilter; label: string; title: string }[] = [
  { key: 'all', label: 'all', title: 'Every message, including tool-only turns' },
  { key: 'text', label: 'text', title: 'Only messages that say something (tool-only turns hidden)' },
  { key: 'prompts', label: 'you', title: 'Only your prompts' }
];

/** True when `f` is a known filter — guards a stale persisted value. */
export function isChatFilter(f: unknown): f is ChatFilter {
  return f === 'all' || f === 'text' || f === 'prompts';
}

export function filterMessages(messages: ChatMessage[], f: ChatFilter): ChatMessage[] {
  if (f === 'all') return messages;
  if (f === 'prompts') return messages.filter(m => m.role === 'user');
  // A tool body (proposed plan / asked question) "says something" — keep it.
  return messages.filter(m => !!m.text || m.tools.some(t => !!t.body));
}
