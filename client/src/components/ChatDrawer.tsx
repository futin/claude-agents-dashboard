import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import Chevron from './Chevron';
import { Markdown } from './Markdown';
import { PermissionBanner } from './PermissionBanner';
import QuestionPanel from './QuestionPanel';
import PlanPanel from './PlanPanel';
import MessagePanel from './MessagePanel';
import ResumePanel from './ResumePanel';
import { TasksCard } from './TasksCard';
import { TraceInspector } from './TraceInspector';
import { TraceSpine } from './TraceSpine';
import { SessionStopControl } from './sessions/SessionStopControl';
import { useBackClose } from '../hooks/useBackClose';
import { useNarrow } from '../hooks/useNarrow';
import { useSessionChat } from '../hooks/useSessionChat';
import { useSessionTrace } from '../hooks/useSessionTrace';
import { usePendingQuestion } from '../hooks/usePendingQuestion';
import { usePendingPlan } from '../hooks/usePendingPlan';
import { usePendingMessage } from '../hooks/usePendingMessage';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSettings } from '../hooks/useSettings';
import { CHAT_FILTERS, filterMessages, isChatFilter, type ChatFilter } from '../lib/chatFilter';
import { fmtTok } from '../lib/format';
import { resumeEligible, stillRunningNote, STILL_RUNNING_DETAIL, STILL_RUNNING_HINT } from '../lib/resume';
import { heldBodyUuid } from '../lib/heldBody';
import { latestSuggestion } from '../lib/composer';
import { formatInterval } from '../lib/settings';
import { surfacePill } from '../lib/surface';
import { TRACE_FILTERS, type TraceFilter, type TraceFolds } from '../lib/trace';
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

/**
 * The sidecar's live context gauge, straight off the same 3s poll that feeds
 * the row — no extra read. A drawer opened from a tapped push never showed the
 * list, so this is the only place that reader sees how full the session is.
 * Same 70% amber threshold the row uses. Chat and Trace both lead with it.
 */
function ContextCard({ session }: { session: Session }) {
  // same 70% threshold the row uses — one context reading, two places.
  const ctxPct = session.contextPct || 0;
  const ctxWarn = ctxPct >= 70;
  return (
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
  );
}

/**
 * `onWhy` opens a tool line's step in Trace; lines without a tool_use id, and every line on a phone (no `onWhy`), get no link.
 * `folded` names the tool whose body a pinned panel is showing right now (`lib/heldBody.ts`): that body renders closed, summary still clickable, and
 * reopens as history once the hold ends.
 */
function Message({ m, onWhy, folded }: { m: ChatMessage; onWhy?(id: string): void; folded?: string }) {
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
          <details open={t.name !== folded} className="cmsg-plan" key={i}>
            <summary>
              <Chevron className="cmsg-chev" />
              <span className="tool">{t.name}</span>
              {' ' + (TOOL_HINT[t.name] ?? '')}
              {t.id && onWhy && (
                // a click inside <summary> would toggle the details: the link only opens Trace
                <button
                  type="button"
                  className="cmsg-why"
                  title="Open this step in Trace"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); onWhy(t.id!); }}
                >why?</button>
              )}
            </summary>
            <div className="cmsg-text">
              <Markdown text={t.body} />
              {t.bodyTruncated && <span className="cmsg-cut">… truncated</span>}
            </div>
          </details>
        ) : (
          t.id && onWhy ? (
            // the name and detail shrink and ellipsise together; `why?` never does
            <div className="cmsg-tool has-why" key={i}>
              <span className="cmsg-what">
                <span className={`tool${t.name === 'Task' ? ' task' : ''}`}>{t.name}</span>
                {t.detail ? ' ' + t.detail : ''}
              </span>
              <button type="button" className="cmsg-why" title="Open this step in Trace" onClick={() => onWhy(t.id!)}>why?</button>
            </div>
          ) : (
            <div className="cmsg-tool" key={i}>
              <span className={`tool${t.name === 'Task' ? ' task' : ''}`}>{t.name}</span>
              {t.detail ? ' ' + t.detail : ''}
            </div>
          )
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
 * (below `md`, 768px, it goes full-screen, where a 1080px modal with margins
 * cannot fit and the scrim is gone again — back and ✕ are the exits there).
 *
 * Scroll behaviour: an append only auto-scrolls when the reader was already at
 * the bottom (so reading history isn't yanked away); a prepend restores the
 * previous position by the height the new page added.
 *
 * A pinned wait panel FLOATS over the transcript rather than pushing it: the
 * body and `.chat-pinned` are siblings in `.chat-stack`, and the pinned layer
 * is absolutely positioned against its bottom edge. The transcript's height is
 * therefore identical with and without a panel — a question arriving mid-read
 * never reflows the sentence being read. What DOES change is the transcript's
 * bottom padding: `--pinned-h` tracks the layer's live height so the newest
 * turn can always be scrolled out from under a composer, which is otherwise
 * tall enough to swallow it whole.
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
  const holds = { question: !!question.pending, plan: !!plan.pending, message: !!message.pending };
  const canResume = resumeEligible(session, holds, spawnAvailable);
  const showStillRunning = stillRunningNote(session, holds);
  const [filter, setFilter] = usePersistedState<ChatFilter>('dashboard.chatFilter', 'all');
  const { settings: { refreshMs } } = useSettings();
  const mode = isChatFilter(filter) ? filter : 'all'; // guard a stale stored value
  const shown = useMemo(() => filterMessages(messages, mode), [messages, mode]);
  const heldAsk = useMemo(() => heldBodyUuid(messages, 'AskUserQuestion', !!question.pending), [messages, question.pending]);
  const heldPlan = useMemo(() => heldBodyUuid(messages, 'ExitPlanMode', !!plan.pending), [messages, plan.pending]);
  // Off the unfiltered page: the text filter must not hide the turn the suggestion belongs to.
  const suggestion = useMemo(() => latestSuggestion(messages), [messages]);
  const surfaceInfo = surfacePill(session.surface);

  // Chat | Trace. Not persisted: the modal always opens in Chat. The trace
  // polls only while it is the view showing. Below `md` (768) there is no
  // Trace: the spine and its sidecar are too small to use on a phone, so the
  // switch and every `why?` go, and a pick made wide falls back to Chat.
  const narrow = useNarrow();
  const [viewPick, setView] = useState<'chat' | 'trace'>('chat');
  const view = narrow ? 'chat' : viewPick;
  const [sel, setSel] = useState<string | null>(null);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>('all');
  const [focus, setFocus] = useState(false);
  const [follow, setFollow] = useState(true);
  const trace = useSessionTrace(session.id, view === 'trace', refreshMs);
  // While following, the pick is the newest step; a pick of its own stops following.
  const newest = trace.steps.length ? trace.steps[trace.steps.length - 1].id : null;
  const picked = follow ? newest : sel;
  // Folds the reader opened or closed by hand. Held here, not in the spine,
  // so a round trip through Chat keeps them; the drawer is keyed by session.
  const [folds, setFolds] = useState<TraceFolds>(() => ({ open: new Set(), closed: new Set() }));
  function setFold(key: string, open: boolean) {
    setFolds(f => {
      const o = new Set(f.open), c = new Set(f.closed);
      if (open) { o.add(key); c.delete(key); } else { o.delete(key); c.add(key); }
      return { open: o, closed: c };
    });
  }

  function pickStep(id: string) {
    setSel(id);
    setFollow(false);
  }

  /** A chat tool line's `why?`: open its step in Trace, picked, not following. */
  function openStep(id: string) {
    setView('trace');
    pickStep(id);
  }

  // What QuestionPanel keys its options on: a pending question it has not
  // already confirmed as sent or seen go. A running decide step then points at it.
  const questionPending = !!question.pending && question.phase !== 'submitted' && question.phase !== 'gone';

  const bodyRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** scrollHeight captured just before an older page is requested. */
  const preHeight = useRef(0);
  /** First message's uuid last render — a change means a prepend landed. */
  const firstId = useRef<string | null>(null);
  /** Filter at last render — a change re-anchors instead of looking like a prepend. */
  const prevMode = useRef(mode);
  /** View at last chat render — coming back from Trace re-anchors like a filter switch. */
  const prevView = useRef(view);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Same intent as Escape above, for the input a phone actually has: below
  // `md` (768px) the drawer is full-width with no scrim to tap, so back is the
  // other exit.
  useBackClose(onClose);

  useLayoutEffect(() => {
    if (view !== 'chat') {
      prevView.current = view;
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    const first = shown.length ? shown[0].uuid : null;
    if (prevMode.current !== mode || prevView.current !== view) {
      // Switching filters changes the whole list, and the transcript remounts
      // on the way back from Trace — either way, jump back to the live tail.
      prevMode.current = mode;
      prevView.current = view;
      firstId.current = first;
      atBottom.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const prepended = firstId.current !== null && first !== firstId.current;
    firstId.current = first;
    if (prepended) el.scrollTop += el.scrollHeight - preHeight.current;
    else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown, mode, view]);

  // The pinned layer covers the transcript's bottom edge, so the transcript
  // pads by exactly its height — a panel appearing, a textarea growing a line
  // or the panel going away all land here. offsetHeight, not
  // getBoundingClientRect: `.shell{zoom}` multiplies the rect but not the
  // layout box, and what we write back is a style px (bug-30 territory).
  // Written on the stack, not the body: the transcript and the Trace spine
  // take turns as its body, and both inherit the one measurement.
  useLayoutEffect(() => {
    const pinned = pinnedRef.current;
    const stack = stackRef.current;
    if (!pinned || !stack) return;
    const measure = () => {
      stack.style.setProperty('--pinned-h', pinned.offsetHeight + 'px');
      // The pad grew under the reader; keep the tail where they were reading it.
      const body = bodyRef.current;
      if (body && atBottom.current) body.scrollTop = body.scrollHeight;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pinned);
    return () => ro.disconnect();
  }, []);

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
          {!narrow && (
            <div className="seg" role="tablist" aria-label="View">
              {(['chat', 'trace'] as const).map(v => (
                <button key={v} role="tab" className={view === v ? 'on' : ''} aria-selected={view === v} onClick={() => setView(v)}>
                  {v === 'chat' ? 'Chat' : 'Trace'}
                </button>
              ))}
            </div>
          )}
          <button className="chat-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="chat-split">
          <div className="chat-side">
            <ContextCard session={session} />

            {/* In the sidecar, not the head: on a phone the thumb goes to ✕, and a stop beside it gets hit by accident even behind the confirm step.
                Renders nothing for a session this dashboard did not spawn (no `stopState`). */}
            <SessionStopControl sessionId={session.id} stopState={session.stopState} showBadge />

            {/* Trace keeps Chat's structure about the picked step: its card in
                the Tasks card's place, its fields as the facts under it. */}
            {view === 'trace' ? (
              <TraceInspector steps={trace.steps} sel={picked} questionPending={questionPending} onPick={pickStep} />
            ) : (
              <>
                <TasksCard tasks={session.tasks} plan={session.taskPlan} />

                {/* Three of these are phone-hidden (`.f.wide`): Project repeats the
                    head's pill, Messages and Now are already on screen — the count
                    in the foot, the live tool in the transcript's last turn. They
                    stay in the DOM for the desktop column, which has the room. */}
                <div className="chat-facts">
                  <div className="f wide"><span>Project</span><b title={session.projectPath || session.project}>{session.project}</b></div>
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
                  <div className="f wide"><span>Messages</span><b>{messages.length} loaded</b></div>
                  <div className="f wide">
                    <span>Now</span>
                    <b title={session.activity ? `${session.activity.tool}${session.activity.detail ? ' ' + session.activity.detail : ''}` : undefined}>
                      {session.activity ? session.activity.tool : '—'}
                    </b>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="chat-col">
            <div className="chat-stack" ref={stackRef}>
              {view === 'trace' ? (
                trace.loading ? (
                  <div className="chat-body"><div className="chat-empty">Loading trace…</div></div>
                ) : trace.error ? (
                  <div className="chat-body"><div className="chat-empty">Couldn’t read this session’s trace.</div></div>
                ) : trace.steps.length === 0 ? (
                  <div className="chat-body"><div className="chat-empty">No tool calls in this transcript yet.</div></div>
                ) : (
                  <TraceSpine
                    steps={trace.steps}
                    sel={picked}
                    filter={traceFilter}
                    focus={focus}
                    follow={follow}
                    folds={folds}
                    dropped={trace.dropped}
                    onPick={pickStep}
                    onFollow={() => setFollow(true)}
                    onFold={setFold}
                  />
                )
              ) : (
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
                    shown.map(m => (
                        <Message
                          key={m.uuid}
                          m={m}
                          onWhy={narrow ? undefined : openStep}
                          folded={m.uuid === heldAsk ? 'AskUserQuestion' : m.uuid === heldPlan ? 'ExitPlanMode' : undefined}
                        />
                      ))
                  )}
                </div>
              )}

              {/* One absolutely-positioned layer for every pinned thing, rather
                  than five: the panels keep stacking in normal flow inside it
                  (MessagePanel's "gone" note over ResumePanel is the hand-off
                  spawn.md documents), and the layer — not each panel — is what
                  caps at the stack's height and scrolls from there. */}
              <div className="chat-pinned" ref={pinnedRef}>
                {/* Terminal permission dialog — a sign, not a control (it can only be
                    answered there). Sits above the question panel; the two can't both
                    be live, since a permission prompt blocks the session. */}
                {session.permissionWait && <PermissionBanner session={session} />}

                {/* The one full rendering of a held question: its tool_use lands in the
                    transcript ~1s into the hold, and that copy renders folded until the
                    hold ends (heldAsk). Pinned so it stays reachable while scrolling. */}
                <QuestionPanel state={question} />

                {/* Same deal for a proposed plan. The two stores are one-entry-per-
                    session and a session can only be parked on one thing at a time, so
                    in practice only one of these ever renders. */}
                <PlanPanel state={plan} />

                {/* And for a turn-end reply window. One-entry-per-session per store and
                    a session parks on one thing at a time, so at most one of the three
                    panels renders. */}
                <MessagePanel state={message} suggestion={suggestion} />

                {/* The opposite case: a dashboard session whose turn is OVER — window
                    expired, released, or capped out. Sends `resume` through the spawn
                    path; the same transcript (same id) continues, so this drawer
                    live-tails the answer. Can render under MessagePanel's "gone" note,
                    which is the natural hand-off. */}
                {canResume && <ResumePanel session={session} suggestion={suggestion} />}

                {/* A dashboard session whose process is alive but not this server's to stop (`processLive`): the composer would only meet a 409,
                    so say why it is missing. The composer returns on the first poll after the process exits. */}
                {showStillRunning && (
                  <div className="qpanel resume">
                    <div className="qp-head">
                      <span className="qp-badge">still running</span>
                      <span className="qp-hint">{STILL_RUNNING_HINT}</span>
                    </div>
                    <div className="qp-note">{STILL_RUNNING_DETAIL}</div>
                  </div>
                )}
              </div>
            </div>

            {/* The filter narrows the transcript, so it sits with the count it
                changes rather than in the facts column — control and readout on
                one line, and no chrome row spent on it. Still the board's
                segmented switch (the same `.seg` the sessions toolbar uses),
                sized down to foot scale. */}
            <div className={`chat-foot${view === 'trace' ? ' tr-foot' : ''}`}>
              <span className="chat-live"><i /> live · refreshing every {formatInterval(refreshMs)}</span>
              {view === 'trace' ? (
                <>
                  {/* no step count: the spine's folds carry it; the not-loaded notice heads the spine */}
                  <button className={`tr-tog${focus ? ' on' : ''}`} aria-pressed={focus} onClick={() => setFocus(f => !f)}>
                    Only this step's why
                  </button>
                  <div className="seg" role="group" aria-label="Step filter">
                    {TRACE_FILTERS.map(f => (
                      <button
                        key={f.key}
                        className={traceFilter === f.key ? 'on' : ''}
                        aria-pressed={traceFilter === f.key}
                        onClick={() => setTraceFilter(f.key)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
