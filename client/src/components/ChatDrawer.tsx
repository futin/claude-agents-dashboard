import { useEffect, useLayoutEffect, useRef } from 'react';

import { useSessionChat } from '../hooks/useSessionChat';
import type { ChatMessage, Session } from '../../../shared/types';

/** Distance from the bottom (px) still counted as "following the tail". */
const FOLLOW_SLACK = 40;

function timeOf(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Message({ m }: { m: ChatMessage }) {
  return (
    <div className={`cmsg ${m.role}`}>
      <div className="cmsg-head">
        <span className="cmsg-role">{m.role === 'user' ? 'you' : 'claude'}</span>
        <span className="cmsg-ts">{timeOf(m.ts)}</span>
      </div>
      {m.text && (
        <div className="cmsg-text">
          {m.text}
          {m.textTruncated && <span className="cmsg-cut"> … truncated</span>}
        </div>
      )}
      {m.tools.map((t, i) => (
        <div className="cmsg-tool" key={i}>
          <span className={`tool${t.name === 'Task' ? ' task' : ''}`}>{t.name}</span>
          {t.detail ? ' ' + t.detail : ''}
        </div>
      ))}
    </div>
  );
}

/**
 * Full-height drawer showing a session's chat history: the newest page on open,
 * live-tailed every 3s, "load older" walking backwards through the transcript.
 *
 * Scroll behaviour: an append only auto-scrolls when the reader was already at
 * the bottom (so reading history isn't yanked away); a prepend restores the
 * previous position by the height the new page added.
 */
export default function ChatDrawer({ session, onClose }: { session: Session; onClose: () => void }) {
  const { messages, hasMore, loading, loadingOlder, error, loadOlder } = useSessionChat(session.id);

  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** scrollHeight captured just before an older page is requested. */
  const preHeight = useRef(0);
  /** First message's uuid last render — a change means a prepend landed. */
  const firstId = useRef<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const first = messages.length ? messages[0].uuid : null;
    const prepended = firstId.current !== null && first !== firstId.current;
    firstId.current = first;
    if (prepended) el.scrollTop += el.scrollHeight - preHeight.current;
    else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
  }

  function onOlder() {
    const el = bodyRef.current;
    preHeight.current = el ? el.scrollHeight : 0;
    void loadOlder();
  }

  return (
    <div className="chat-back" onClick={onClose}>
      <aside className="chat" onClick={e => e.stopPropagation()} role="dialog" aria-label="Session chat history">
        <div className="chat-head">
          <span className="chat-title">{session.sessionName || session.project}</span>
          {session.sessionName && <span className="proj-pill">{session.project}</span>}
          {session.gitBranch && <span className="branch">{session.gitBranch}</span>}
          <span className="chat-model">{session.model}</span>
          <button className="chat-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
          {hasMore && (
            <button className="chat-older" onClick={onOlder} disabled={loadingOlder}>
              {loadingOlder ? 'loading…' : 'load older'}
            </button>
          )}
          {loading ? (
            <div className="chat-empty">Loading chat…</div>
          ) : error ? (
            <div className="chat-empty">Couldn’t read this session’s transcript.</div>
          ) : messages.length === 0 ? (
            <div className="chat-empty">No messages in this transcript yet.</div>
          ) : (
            messages.map(m => <Message key={m.uuid} m={m} />)
          )}
        </div>

        <div className="chat-foot">
          <span>live · refreshing every 3s</span>
          <span className="chat-count">{messages.length} shown</span>
        </div>
      </aside>
    </div>
  );
}
