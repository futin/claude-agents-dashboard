import { useCallback, useEffect, useState } from 'react';

import { useSettings } from './useSettings';
import { createChatPaging } from '../lib/chatPaging';
import { chatQuery } from '../lib/settings';
import type { ChatMessage, SessionChat } from '../../../shared/types';

export interface ChatState {
  /** Oldest-first, growing at the bottom (live tail) and top (load older). */
  messages: ChatMessage[];
  /** History exists above `messages[0]`. */
  hasMore: boolean;
  /** First page hasn't landed yet. */
  loading: boolean;
  loadingOlder: boolean;
  error: boolean;
  loadOlder: () => Promise<void>;
}

/**
 * Fetch `/api/sessions/:id/chat` — the newest page once, then only the bytes
 * appended since, every 3s. Paging is by byte offset (see `lib/chat.ts`):
 * `cursor` walks forward for the tail, `headOffset` backwards for older pages.
 * Both live in `createChatPaging`, outside React state, so the poll always sees
 * the latest without re-arming.
 */
export function useSessionChat(id: string): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState(false);

  /** Byte offsets plus the one-poll-at-a-time and per-tail epoch rules — see `lib/chatPaging.ts`. */
  const [paging] = useState(createChatPaging);
  const { settings: { refreshMs, chatFullText } } = useSettings();

  /** `cursor` is the paging param; `chatQuery` bolts the truncation flag on. */
  const get = useCallback(async (cursor: string): Promise<SessionChat | null> => {
    try {
      const query = chatQuery({ chatFullText }, cursor);
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/chat${query}`);
      return (await res.json()) as SessionChat;
    } catch {
      return null; // keep the last snapshot; the next poll retries
    }
  }, [id, chatFullText]);

  useEffect(() => {
    let live = true;
    setMessages([]);
    setHasMore(false);
    setLoading(true);
    setError(false);

    async function tail(): Promise<void> {
      const epoch = paging.retail();
      // Every re-tail — a reset poll's too — strands a "load older" in flight as stale, and only this can clear its spinner.
      setLoadingOlder(false);
      const page = await get('');
      if (!live) return;
      if (!page) {
        setLoading(false);
        setError(true);
        return;
      }
      if (!paging.tailLanded(epoch, page)) return;
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setError(!!page.error);
      setLoading(false);
    }

    async function poll(): Promise<void> {
      const ticket = paging.beginPoll();
      if (!ticket) return;
      const page = await get('after=' + ticket.after);
      if (!live) return;
      const next = paging.endPoll(ticket, page);
      // Transcript truncated/rotated — our cursor means nothing now.
      if (next === 'reset') void tail();
      else if (next === 'append' && page!.messages.length) setMessages(cur => cur.concat(page!.messages));
    }

    void tail();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Retuning the rate — or flipping the truncation toggle, which re-keys
    // `get` — re-tails the drawer. Harmless, and it's what you want after
    // toggling: the page has to be refetched to gain the text the server cut.
  }, [get, refreshMs, paging]);

  const loadOlder = useCallback(async () => {
    const ticket = paging.beginOlder();
    if (!ticket) return;
    setLoadingOlder(true);
    const page = await get('before=' + ticket.before);
    const next = paging.endOlder(ticket, page);
    // A stale page belongs to a transcript this drawer has re-tailed away from; its spinner was already cleared by the re-tail.
    if (next === 'stale') return;
    setLoadingOlder(false);
    if (next !== 'prepend') return;
    setHasMore(page!.hasMore);
    if (page!.messages.length) setMessages(cur => page!.messages.concat(cur));
  }, [get, paging]);

  return { messages, hasMore, loading, loadingOlder, error, loadOlder };
}
