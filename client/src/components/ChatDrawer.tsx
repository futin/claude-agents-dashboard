import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { Markdown } from './Markdown';
import { PermissionBanner } from './PermissionBanner';
import QuestionPanel from './QuestionPanel';
import PlanPanel from './PlanPanel';
import MessagePanel from './MessagePanel';
import ResumePanel from './ResumePanel';
import { useBackClose } from '../hooks/useBackClose';
import { useSessionChat } from '../hooks/useSessionChat';
import { usePendingQuestion } from '../hooks/usePendingQuestion';
import { usePendingPlan } from '../hooks/usePendingPlan';
import { usePendingMessage } from '../hooks/usePendingMessage';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSettings } from '../hooks/useSettings';
import { CHAT_FILTERS, filterMessages, isChatFilter, type ChatFilter } from '../lib/chatFilter';
import { fmtTok } from '../lib/format';
import { resumeEligible } from '../lib/resume';
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
 * A centred modal showing a session's chat history: the newest page on open,
 * live-tailed every 3s, "load older" walking backwards through the transcript.
 *
 * Layout is the sidecar of `.claude/DESIGN.md` §8.6 — a 290px left column
 * carrying the session's facts (context gauge, project, branch, model, surface,
 * messages loaded, current tool), with the All / Text / You filter down in the
 * foot beside the count it changes. The modal floats over the
 * scrim with air on every side, so the scrim is a real exit at every width
 * (below 700px it goes full-screen, where a 1080px modal with margins cannot
 * fit and the scrim is gone again — back and ✕ are the exits there).
 *
 * Scroll behaviour: an append only auto-scrolls when the reader was already at
 * the bottom (so reading history isn't yanked away); a prepend restores the
 * previous position by the height the new page added.
 *
 * A pinned wait panel FLOATS over the transcript rather than pushing it: the
 * body and `.chat-pinned` are siblings in `.chat-stack`, and the pinned layer
 * is absolutely positioned against its bottom edge. The transcript's height is
 * therefore identical with and without a panel — a question arriving mid-read
 * never reflows the sentence being read.
 */
export default function ChatDrawer({ session, onClose, spawnAvailable }: {
  session: Session; onClose: () => void;
  /** From the health poll SessionsView owns — gates the resume composer. */
  spawnAvailable?: boolean;
}) {
  const { messages, hasMore, loading, loadingOlder, error, loadOlder } = useSessionChat(session.id);
  const question = usePendingQuestion(session.id);
  const plan = usePendingPlan(session.id);
  const message = usePendingMessage(session.id);
  const canResume = resumeEligible(
    session,
    { question: !!question.pending, plan: !!plan.pending, message: !!message.pending },
    spawnAvailable
  );
  const [filter, setFilter] = usePersistedState<ChatFilter>('dashboard.chatFilter', 'all');
  const { settings: { refreshMs } } = useSettings();
  const mode = isChatFilter(filter) ? filter : 'all'; // guard a stale stored value
  const shown = useMemo(() => filterMessages(messages, mode), [messages, mode]);
  const surfaceInfo = surfacePill(session.surface);
  // same 70% threshold the row uses — one context reading, two places.
  const ctxPct = session.contextPct || 0;
  const ctxWarn = ctxPct >= 70;

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

  // Same intent as Escape above, for the input a phone actually has: at <=700px
  // the drawer is full-width with no scrim to tap, so back is the other exit.
  useBackClose(onClose);

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
        {/* The head keeps the session's name, the project pill and the close
            control. Everything else it used to carry — branch, model, surface,
            the live context reading — moved into the sidecar below, where it
            has room to be read rather than ellipsised. */}
        <div className="chat-head">
          <span className="chat-title">{session.sessionName || session.project}</span>
          {session.sessionName && <span className="proj-pill">{session.project}</span>}
          <span className="spacer" />
          <button className="chat-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="chat-split">
          <div className="chat-side">
            {/* live context, straight off the same 3s poll that feeds the row —
                no extra read. A drawer opened from a tapped push never showed
                the list, so this is the only place that reader sees how full
                the session is. Same 70% amber threshold the row uses. */}
            <div className="kv">
              <div className="k">Context</div>
              <div className="v">
                <span className={`metric${ctxWarn ? ' warn' : ''}`}>{ctxPct}%</span>
                <span className="u">
                  <span className="tok" title={`${session.tokens.toLocaleString()} of ${session.contextWindow.toLocaleString()} context tokens`}>
                    {fmtTok(session.tokens)} / {session.contextWindowLabel}
                  </span>
                </span>
              </div>
              <div className="track">
                <div className={`fill${ctxWarn ? ' warn' : ''}`} style={{ width: `${Math.min(ctxPct, 100)}%` }} />
              </div>
            </div>

            <div className="chat-facts">
              <div className="f"><span>Project</span><b title={session.projectPath || session.project}>{session.project}</b></div>
              {/* the value ellipsises in a 290px column, so keep the full ref reachable */}
              {session.gitBranch && (
                <div className="f"><span>Branch</span><b title={session.gitBranch}>{session.gitBranch}</b></div>
              )}
              <div className="f"><span>Model</span><b>{session.model}</b></div>
              {/* repeated from the row on purpose: a drawer opened straight from
                  a tapped push (`?session=<id>`) never showed the list, so this
                  is the first place the reader learns the session lives only
                  here. */}
              {surfaceInfo && (
                <div className="f"><span>Surface</span><b title={surfaceInfo.title}>{surfaceInfo.label}</b></div>
              )}
              <div className="f"><span>Messages</span><b>{messages.length} loaded</b></div>
              <div className="f">
                <span>Now</span>
                <b title={session.activity ? `${session.activity.tool}${session.activity.detail ? ' ' + session.activity.detail : ''}` : undefined}>
                  {session.activity ? session.activity.tool : '—'}
                </b>
              </div>
            </div>
          </div>

          <div className="chat-col">
            <div className="chat-stack">
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

              {/* One absolutely-positioned layer for every pinned thing, rather
                  than five: the panels keep stacking in normal flow inside it
                  (MessagePanel's "gone" note over ResumePanel is the hand-off
                  spawn.md documents), and the layer — not each panel — is what
                  caps at the stack's height and scrolls from there. */}
              <div className="chat-pinned">
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

                {/* The opposite case: a dashboard session whose turn is OVER — window
                    expired, released, or capped out. Sends `resume` through the spawn
                    path; the same transcript (same id) continues, so this drawer
                    live-tails the answer. Can render under MessagePanel's "gone" note,
                    which is the natural hand-off. */}
                {canResume && <ResumePanel session={session} />}
              </div>
            </div>

            {/* The filter narrows the transcript, so it sits with the count it
                changes rather than in the facts column — control and readout on
                one line, and no chrome row spent on it. Still the board's
                segmented switch (the same `.seg` the sessions toolbar uses),
                sized down to foot scale. */}
            <div className="chat-foot">
              <span className="chat-live"><i /> live · refreshing every {formatInterval(refreshMs)}</span>
              <span className="chat-count">
                {mode === 'all' ? `${messages.length} shown` : `${shown.length} of ${messages.length} shown`}
              </span>
              <div className="seg" role="group" aria-label="Message filter">
                {CHAT_FILTERS.map(f => (
                  <button
                    key={f.key}
                    className={mode === f.key ? 'on' : ''}
                    title={f.title}
                    aria-pressed={mode === f.key}
                    onClick={() => setFilter(f.key)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
