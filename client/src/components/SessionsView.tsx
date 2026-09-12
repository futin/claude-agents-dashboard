import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { AsideAccount } from './AsideAccount';
import { AsideBoard } from './AsideBoard';
import { Toolbar } from './Toolbar';
import { BoardView } from './sessions/BoardView';
import { EmptyState } from './sessions/EmptyState';
import { ListView } from './sessions/ListView';
import { SplitView } from './sessions/SplitView';
import { TilesView } from './sessions/TilesView';
import { TriageView } from './sessions/TriageView';
import { deepLinkSession } from '../lib/deepLink';
import { usePersistedState } from '../hooks/usePersistedState';
import { useRemoteAnswer } from '../hooks/useRemoteAnswer';
import { useSessions } from '../hooks/useSessions';
import { useSettings } from '../hooks/useSettings';
import { useWebNotify } from '../hooks/useWebNotify';
import { applyView, clearFilters, describeEmpty, pruneProjects, DEFAULT_LAYOUT, DEFAULT_VIEW, type Layout, type View } from '../lib/filterSort';
import { formatInterval, resolveLayout } from '../lib/settings';

/** Own chunk — the drawer only loads the first time a chat is opened. */
const ChatDrawer = lazy(() => import('./ChatDrawer'));
/** Own chunk, same reasoning — most sessions never spawn one of these. */
const SpawnPanel = lazy(() => import('./SpawnPanel'));

/**
 * The live sessions monitor — the app's original single view. Owns the 3s
 * poll (useSessions), so switching to another section unmounts it and stops
 * polling.
 *
 * Two columns: the list in whichever of the five shapes the toolbar picked, and
 * a 320px aside with the Account gauges and the Board facts. Below 1100px the
 * aside moves above the toolbar (styles.css).
 */
export function SessionsView() {
  const { data, connected } = useSessions();
  const { settings } = useSettings();
  const [view, setView] = usePersistedState<View>('dashboard.view', DEFAULT_VIEW);
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
  // Not persisted: session ids churn, so a restored selection would be stale
  // (see docs/subsystems/view-persistence.md). `expanded` is the set of rows
  // drawn open in the board, list and tiles; `splitId` is the split view's one
  // inspected session. Two states, because opening three cards on the board
  // and then switching to split should not pick one of them at random.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [splitId, setSplitId] = useState<string | null>(null);
  // Seeded from a `?session=` deep link, which is consumed once and stripped.
  const [chatId, setChatId] = useState<string | null>(() => deepLinkSession());
  // Not persisted either: a one-shot form, not a view setting.
  const [spawnOpen, setSpawnOpen] = useState(false);
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
    const pruned = pruneProjects(view.projects, data.sessions);
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

  // A resume's id already names a real row — its `launching` phantom would be
  // a duplicate, so only its FAILURE is worth a row of its own.
  const phantoms = useMemo(
    () => (data?.launching ?? []).filter(l => !l.resume || l.state === 'failed'),
    [data]
  );

  function toggle(id: string) {
    setExpanded(cur => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const chatSession = chatId && data ? data.sessions.find(s => s.id === chatId) : undefined;

  let body: React.ReactNode;
  if (shown === null || (!shown.length && !phantoms.length)) {
    body = <EmptyState loading={shown === null} empty={empty} onClearFilters={() => setView(clearFilters(view))} />;
  } else {
    const common = { sessions: shown, launching: phantoms, expanded, onToggle: toggle, onOpenChat: setChatId };
    body = layout === 'list' ? <ListView {...common} />
      : layout === 'split' ? <SplitView sessions={shown} launching={phantoms} selectedId={splitId} onSelect={setSplitId} onOpenChat={setChatId} />
      : layout === 'tiles' ? <TilesView {...common} />
      : layout === 'triage' ? <TriageView sessions={shown} launching={phantoms} onOpenChat={setChatId} />
      : <BoardView {...common} />;
  }

  return (
    <div className="sessions">
      <aside className="s-aside">
        <AsideAccount data={data} />
        <AsideBoard data={data} remoteAnswer={remoteAnswer} onOpenSpawn={() => setSpawnOpen(true)} />
      </aside>
      <div className="s-main">
        <Toolbar
          sessions={data ? data.sessions : []}
          view={view}
          onChange={setView}
          layout={layout}
          onLayout={changeLayout}
        />
        {spawnOpen && (
          <Suspense fallback={null}>
            <SpawnPanel
              onClose={() => setSpawnOpen(false)}
              onLaunched={id => { setChatId(id); setSpawnOpen(false); }}
              spawnMaxPermission={remoteAnswer.state?.spawnMaxPermission}
            />
          </Suspense>
        )}
        <div className="s-body">{body}</div>
        <div className="foot">
          {connected
            ? `live · refreshing every ${formatInterval(settings.refreshMs)}`
            : <span className="off">disconnected — server stopped?</span>}
        </div>
      </div>
      {chatSession && (
        <Suspense fallback={null}>
          {/* keyed by id: switching sessions remounts the tail cleanly */}
          <ChatDrawer
            key={chatSession.id}
            session={chatSession}
            onClose={() => setChatId(null)}
            spawnAvailable={remoteAnswer.state?.spawnAvailable}
          />
        </Suspense>
      )}
    </div>
  );
}
