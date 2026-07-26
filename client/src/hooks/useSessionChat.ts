import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessage, SessionChat } from '../../../shared/types';

const POLL_MS = 3000;

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
 * Both live in refs so the poll always sees the latest without re-arming.
 */
export function useSessionChat(id: string): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState(false);

  const cursor = useRef(0);
  const head = useRef(0);
  /** The first page landed — until then the poll must not fire (?after=0 = whole file). */
  const ready = useRef(false);
  /** An older-page request is in flight. */
  const busy = useRef(false);

  const get = useCallback(async (query: string): Promise<SessionChat | null> => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/chat${query}`);
      return (await res.json()) as SessionChat;
    } catch {
      return null; // keep the last snapshot; the next poll retries
    }
  }, [id]);

  useEffect(() => {
    let live = true;
    ready.current = false;
    busy.current = false;
    cursor.current = 0;
    head.current = 0;
    setMessages([]);
    setHasMore(false);
    setLoading(true);
    setError(false);

    async function tail(): Promise<void> {
      const page = await get('');
      if (!live) return;
      if (!page) {
        setLoading(false);
        setError(true);
        return;
      }
      cursor.current = page.cursor;
      head.current = page.headOffset;
      ready.current = true;
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setError(!!page.error);
      setLoading(false);
    }

    async function poll(): Promise<void> {
      if (!ready.current) return;
      const page = await get('?after=' + cursor.current);
      if (!live || !page || page.error) return;
      if (page.reset) {
        // Transcript truncated/rotated — our cursor means nothing now.
        ready.current = false;
        void tail();
        return;
      }
      cursor.current = page.cursor;
      if (page.messages.length) setMessages(cur => cur.concat(page.messages));
    }

    void tail();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [get]);

  const loadOlder = useCallback(async () => {
    if (busy.current || head.current <= 0) return;
    busy.current = true;
    setLoadingOlder(true);
    try {
      const page = await get('?before=' + head.current);
      if (!page || page.error) return;
      head.current = page.headOffset;
      setHasMore(page.hasMore);
      if (page.messages.length) setMessages(cur => page.messages.concat(cur));
    } finally {
      busy.current = false;
      setLoadingOlder(false);
    }
  }, [get]);

  return { messages, hasMore, loading, loadingOlder, error, loadOlder };
}
