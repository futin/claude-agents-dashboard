import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { AsideBoard } from './AsideBoard';
import { AsideStrip } from './sessions/AsideStrip';
import { Toolbar } from './Toolbar';
import { BoardView } from './sessions/BoardView';
import { EmptyState } from './sessions/EmptyState';
import { LoadBoundary } from './LoadBoundary';
import { ListView } from './sessions/ListView';
import { SplitView } from './sessions/SplitView';
import { TilesView } from './sessions/TilesView';
import { TriageView } from './sessions/TriageView';
import { chatDrawerSession, chatRowAction } from '../lib/chatRow';
import { deepLinkSession } from '../lib/deepLink';
import { pollFetch } from '../lib/pollSeq';
import { useNarrow } from '../hooks/useNarrow';
import { usePersistedState } from '../hooks/usePersistedState';
import { useRemoteAnswer } from '../hooks/useRemoteAnswer';
import { useSessions } from '../hooks/useSessions';
import { useSettings } from '../hooks/useSettings';
import { useWebNotify } from '../hooks/useWebNotify';
import { applyView, availableProjects, clearFilters, describeEmpty, drawableLayout, phantomRows, pruneProjects, sessionsEmpty, DEFAULT_LAYOUT, DEFAULT_VIEW, type Layout, type View } from '../lib/filterSort';
import { DESKTOP_LAUNCHED_TEXT } from '../lib/launchSurface';
import { resolveLayout } from '../lib/settings';
import type { Session, SessionsResponse } from '../../../shared/types';

/** Own chunk — the drawer only loads the first time a chat is opened. */
const ChatDrawer = lazy(() => import('./ChatDrawer'));
/** How long the desktop-launch line stays before clearing itself; long enough to read, short enough not to outlive the row it announces. */
const DESKTOP_LAUNCHED_SHOWN_MS = 8000;

/** Own chunk, same reasoning — most sessions never spawn one of these. */
const SpawnPanel = lazy(() => import('./SpawnPanel'));

/**
 * The live sessions monitor — the app's original single view. Owns the 3s
 * poll (useSessions), so switching to another section unmounts it and stops
 * polling.
 *
 * Two columns: the list in whichever of the five shapes the toolbar picked, and
 * a 320px aside carrying the Board facts. (The Account gauges used to sit above
 * them; they are the shell's header chip now — `HeaderAccount` — because they
 * are true of the account wherever you are standing, not of this board.) Below
 * `2xl` (1536px, the lock) the aside moves above the toolbar (styles.css);
 * below `md` (768px) the card is replaced outright by `AsideStrip`, one pinned
 * bar carrying its summary.
 */
export function SessionsView({ onLink }: {
  /**
   * Link health of the poll this view owns, handed up so the shell can draw the
   * "live · refreshing every 3s" line at the foot of the rail (`SideRail`)
   * instead of under the board. Reported on every change, mount included.
   * `working` is whether any session is mid-turn — the wordmark's cursor
   * blinks on it. `scanFailed` is the server answering with a failed scan — the rail says the rows are the last good snapshot.
   */
  onLink?: (link: { connected: boolean; working: boolean; scanFailed: boolean }) => void;
} = {}) {
  const { settings } = useSettings();
  const [view, setView] = usePersistedState<View>('dashboard.view', DEFAULT_VIEW);
  // The project facet is filtered by the server, before its row limit, so a project with no session among the newest N still fills the list;
  // `applyView` re-applies it harmlessly, and covers the one poll still in flight from before the pick.
  const { data, connected, scanFailed } = useSessions({ projects: view.projects });
  const working = data?.sessions.some(s => s.status === 'working') ?? false;
  useEffect(() => { onLink?.({ connected, working, scanFailed }); }, [connected, working, scanFailed, onLink]);
  // The shape gets its own key rather than riding in `view`: it is not a
  // filter. The switcher always writes it, and `defaultLayout` decides whether
  // a load reads it back (`last`) or pins a shape and ignores it. Writing it
  // even when a shape is pinned is the point — flipping the setting back to
  // `last` then resumes from the shape you were actually using. Resolved once,
  // in the initializer, so there is no flash of the wrong shape.
  const [storedLayout, setStoredLayout] = usePersistedState<Layout>('dashboard.layout', DEFAULT_LAYOUT);
  const [layout, setLayout] = useState<Layout>(() => resolveLayout(settings.defaultLayout, storedLayout));
  const changeLayout = (l: Layout): void => {
    setLayout(l);
    setStoredLayout(l);
  };
  // A phone draws the board where the choice says list or split — those two
  // need a desktop measure (`drawableLayout`). Only the *drawing* is coerced:
  // `layout` and its stored key keep the real choice, so widening the window
  // comes straight back to it without the user re-picking.
  const narrow = useNarrow();
  const drawn = drawableLayout(layout, narrow);
  // Not persisted: session ids churn, so a restored selection would be stale
  // (see docs/subsystems/view-persistence.md). `expanded` is the set of rows
  // drawn open in the board, list and tiles; `splitId` is the split view's one
  // inspected session. Two states, because opening three cards on the board
  // and then switching to split should not pick one of them at random.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [splitId, setSplitId] = useState<string | null>(null);
  // Seeded from a `?session=` deep link, which is consumed once and stripped.
  const [chatId, setChatId] = useState<string | null>(() => deepLinkSession());
  // The poll is project-filtered, so a deep-linked or launched session outside the filter needs its row fetched for the drawer (`lib/chatRow.ts`).
  const [fetchedChat, setFetchedChat] = useState<Session | null>(null);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const chatFetching = useRef(false);
  // Not persisted either: a one-shot form, not a view setting.
  const [spawnOpen, setSpawnOpen] = useState(false);
  // What a desktop launch leaves behind besides the chat drawer: the session is about to move, so this line says where it is going.
  const [desktopLaunched, setDesktopLaunched] = useState(false);
  useEffect(() => {
    if (!desktopLaunched) return;
    const t = setTimeout(() => setDesktopLaunched(false), DESKTOP_LAUNCHED_SHOWN_MS);
    return () => clearTimeout(t);
  }, [desktopLaunched]);
  // One `/api/health` poll, owned here so the Board card (badge, switch, the
  // New session gate) and the spawn panel (its permission-mode ceiling) read
  // the same snapshot instead of each starting their own.
  const remoteAnswer = useRemoteAnswer();
  // Rides this view's poll, so it is bound to it: nothing announces while
  // another section is open. See docs/subsystems/push-notify.md.
  useWebNotify(data?.sessions);

  // The project facet is persisted, so a selection can outlive the sessions it
  // named: every row then fails the filter and the list claims there are no
  // recent sessions at all. Once a payload proves a selected project is gone,
  // drop it — losing the last one means "All projects" again. Deliberately
  // project-only: statuses and the activity window are fixed enums that cannot
  // go stale this way.
  useEffect(() => {
    if (!data) return;
    const pruned = pruneProjects(view.projects, availableProjects(data));
    if (pruned !== view.projects) setView({ ...view, projects: pruned });
  }, [data, view, setView]);

  // One clock for both, so the activity-window predicate cannot decide a row is
  // out of the window while the explanation says it is in.
  const { shown, empty } = useMemo(() => {
    if (!data) return { shown: null, empty: null };
    const nowMs = Date.now();
    return {
      shown: applyView(data.sessions, view, nowMs),
      empty: describeEmpty(data.sessions, view, nowMs)
    };
  }, [data, view]);

  const phantoms = useMemo(() => phantomRows(data?.launching), [data]);

  function toggle(id: string) {
    setExpanded(cur => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // The payload on screen when `chatId` was armed; only a later one may fetch, so a launch is never judged by a poll that predates it.
  const chatArmedAt = useRef<SessionsResponse | null>(null);
  useEffect(() => { chatArmedAt.current = data; }, [chatId]);
  useEffect(() => {
    const fresh = data !== chatArmedAt.current;
    if (chatFetching.current || chatRowAction({ chatId, data, fetchedId: fetchedChat?.id ?? null, fresh }) !== 'fetch') return;
    const id = chatId as string;
    chatFetching.current = true;
    void (async () => {
      let status: number | 'error';
      let row: Session | null = null;
      try {
        const res = await pollFetch(`/api/sessions/${encodeURIComponent(id)}/row`);
        status = res.status;
        if (res.ok) row = await res.json() as Session;
      } catch {
        status = 'error';
      }
      chatFetching.current = false;
      // Closed, or another session opened, while this was in flight.
      if (chatIdRef.current !== id) return;
      if (row) setFetchedChat(row);
      else if (chatRowAction({ chatId: id, data, fetchedId: null, fresh, status }) === 'clear') setChatId(null);
    })();
  }, [chatId, data, fetchedChat]);

  const chatSession = chatDrawerSession(chatId, data, fetchedChat);

  let body: React.ReactNode;
  // `shown === null` again only so TypeScript narrows the else branch; `sessionsEmpty` already counts loading as empty.
  if (shown === null || sessionsEmpty(shown, phantoms)) {
    body = <EmptyState loading={shown === null} failed={scanFailed} empty={empty} onClearFilters={() => setView(clearFilters(view))} />;
  } else {
    const common = { sessions: shown, launching: phantoms, expanded, onToggle: toggle, onOpenChat: setChatId };
    body = drawn === 'list' ? <ListView {...common} />
      : drawn === 'split' ? <SplitView sessions={shown} launching={phantoms} selectedId={splitId} onSelect={setSplitId} onOpenChat={setChatId} />
      : drawn === 'tiles' ? <TilesView {...common} />
      : drawn === 'triage' ? <TriageView sessions={shown} launching={phantoms} onOpenChat={setChatId} />
      : <BoardView {...common} />;
  }

  return (
    <div className="sessions">
      {/* Swapped in the markup and not hidden in CSS, for the reason the
          toolbar's switcher filters its shapes: a `display:none` control is
          still a tab stop and still clickable by script, and this would be two
          sets of the same controls in the page at once. */}
      {narrow ? (
        <AsideStrip data={data} remoteAnswer={remoteAnswer} onOpenSpawn={() => setSpawnOpen(true)} />
      ) : (
        <aside className="s-aside">
          <AsideBoard data={data} remoteAnswer={remoteAnswer} onOpenSpawn={() => setSpawnOpen(true)} />
        </aside>
      )}
      <div className="s-main">
        <Toolbar
          projects={data ? availableProjects(data) : []}
          view={view}
          onChange={setView}
          layout={drawn}
          onLayout={changeLayout}
          narrow={narrow}
        />
        {spawnOpen && (
          <LoadBoundary variant="float">
            <Suspense fallback={null}>
              <SpawnPanel
                onClose={() => setSpawnOpen(false)}
                onLaunched={r => {
                  if (r.sessionId) setChatId(r.sessionId);
                  if (r.surface === 'desktop') setDesktopLaunched(true);
                  setSpawnOpen(false);
                }}
                spawnMaxPermission={remoteAnswer.state?.spawnMaxPermission}
                spawnAvailable={remoteAnswer.state?.spawnAvailable}
                desktopAvailable={remoteAnswer.state?.desktopAvailable}
                launchSurfaceDefault={remoteAnswer.state?.launchSurfaceDefault}
              />
            </Suspense>
          </LoadBoundary>
        )}
        {desktopLaunched && (
          <div className="spawn-done" role="status">
            <span>{DESKTOP_LAUNCHED_TEXT}</span>
            <button type="button" className="spawn-done-x" onClick={() => setDesktopLaunched(false)} aria-label="Dismiss">✕</button>
          </div>
        )}
        <div className="s-body">{body}</div>
      </div>
      {chatSession && (
        <LoadBoundary variant="float">
          <Suspense fallback={null}>
            {/* keyed by id: switching sessions remounts the tail cleanly */}
            <ChatDrawer
              key={chatSession.id}
              session={chatSession}
              onClose={() => { setChatId(null); setFetchedChat(null); }}
              spawnAvailable={remoteAnswer.state?.spawnAvailable}
              desktopAvailable={remoteAnswer.state?.desktopAvailable}
            />
          </Suspense>
        </LoadBoundary>
      )}
    </div>
  );
}
