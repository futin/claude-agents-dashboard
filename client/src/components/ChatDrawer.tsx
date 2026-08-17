import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { Markdown } from './Markdown';
import { PermissionBanner } from './PermissionBanner';
import QuestionPanel from './QuestionPanel';
import PlanPanel from './PlanPanel';
import MessagePanel from './MessagePanel';
import { useSessionChat } from '../hooks/useSessionChat';
import { usePendingQuestion } from '../hooks/usePendingQuestion';
import { usePendingPlan } from '../hooks/usePendingPlan';
import { usePendingMessage } from '../hooks/usePendingMessage';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSettings } from '../hooks/useSettings';
import { CHAT_FILTERS, filterMessages, isChatFilter, type ChatFilter } from '../lib/chatFilter';
import { formatInterval } from '../lib/settings';
import { surfacePill } from '../lib/surface';
import type { ChatMessage, Session } from '../../../shared/types';

/** Distance from the bottom (px) still counted as "following the tail". */
const FOLLOW_SLACK = 40;

/** Summary hint for tools whose full body renders as a block (`ChatToolCall.body`). */
const TOOL_HINT: Record<string, string> = {
  ExitPlanMode: 'proposed a plan',
  AskUserQuestion: 'asked a question'
};

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
          <Markdown text={m.text} />
          {m.textTruncated && <span className="cmsg-cut">… truncated</span>}
        </div>
      )}
      {m.tools.map((t, i) =>
        t.body ? (
          <details open className="cmsg-plan" key={i}>
            <summary>
              <span className="tool">{t.name}</span>
              {' ' + (TOOL_HINT[t.name] ?? '')}
            </summary>
            <div className="cmsg-text">
              <Markdown text={t.body} />
              {t.bodyTruncated && <span className="cmsg-cut">… truncated</span>}
            </div>
          </details>
        ) : (
          <div className="cmsg-tool" key={i}>
            <span className={`tool${t.name === 'Task' ? ' task' : ''}`}>{t.name}</span>
            {t.detail ? ' ' + t.detail : ''}
          </div>
        )
      )}
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
  const question = usePendingQuestion(session.id);
  const plan = usePendingPlan(session.id);
  const message = usePendingMessage(session.id);
  const [filter, setFilter] = usePersistedState<ChatFilter>('dashboard.chatFilter', 'all');
  const { settings: { refreshMs } } = useSettings();
  const mode = isChatFilter(filter) ? filter : 'all'; // guard a stale stored value
  const shown = useMemo(() => filterMessages(messages, mode), [messages, mode]);
  const surfaceInfo = surfacePill(session.surface);

  const bodyRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** scrollHeight captured just before an older page is requested. */
  const preHeight = useRef(0);
  /** First message's uuid last render — a change means a prepend landed. */
  const firstId = useRef<string | null>(null);
  /** Filter at last render — a change re-anchors instead of looking like a prepend. */
  const prevMode = useRef(mode);

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
    const first = shown.length ? shown[0].uuid : null;
    if (prevMode.current !== mode) {
      // Switching filters changes the whole list — jump back to the live tail.
      prevMode.current = mode;
      firstId.current = first;
      atBottom.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const prepended = firstId.current !== null && first !== firstId.current;
    firstId.current = first;
    if (prepended) el.scrollTop += el.scrollHeight - preHeight.current;
    else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown, mode]);

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
          {/* repeated from the row on purpose: a drawer opened straight from a
              tapped push (`?session=<id>`) never showed the list, so this is
              the first place the reader learns the session lives only here. */}
          {surfaceInfo && (
            <span className={`ag-pill surface ${session.surface}`} title={surfaceInfo.title}>{surfaceInfo.label}</span>
          )}
          <button className="chat-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="chat-filter" role="group" aria-label="Message filter">
          {CHAT_FILTERS.map(f => (
            <button
              key={f.key}
              className={`cf-btn${mode === f.key ? ' on' : ''}`}
              title={f.title}
              aria-pressed={mode === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
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
          ) : shown.length === 0 ? (
            <div className="chat-empty">
              Nothing matches this filter in the {messages.length} messages loaded
              {hasMore ? ' — load older, or switch back to “all”.' : '.'}
            </div>
          ) : (
            shown.map(m => <Message key={m.uuid} m={m} />)
          )}
        </div>

        {/* Terminal permission dialog — a sign, not a control (it can only be
            answered there). Sits above the question panel; the two can't both
            be live, since a permission prompt blocks the session. */}
        {session.permissionWait && <PermissionBanner session={session} />}

        {/* An action bar, not a message: the question itself already renders in
            the transcript above. Pinned so it stays reachable while scrolling. */}
        <QuestionPanel state={question} />

        {/* Same deal for a proposed plan. The two stores are one-entry-per-
            session and a session can only be parked on one thing at a time, so
            in practice only one of these ever renders. */}
        <PlanPanel state={plan} />

        {/* And for a turn-end reply window. One-entry-per-session per store and
            a session parks on one thing at a time, so at most one of the three
            panels renders. */}
        <MessagePanel state={message} />

        <div className="chat-foot">
          <span>live · refreshing every {formatInterval(refreshMs)}</span>
          <span className="chat-count">
            {mode === 'all' ? `${messages.length} shown` : `${shown.length} of ${messages.length} shown`}
          </span>
        </div>
      </aside>
    </div>
  );
}
