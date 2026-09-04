import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { Header } from './Header';
import { SessionList } from './SessionList';
import { Toolbar } from './Toolbar';
import { deepLinkSession } from '../lib/deepLink';
import { usePersistedState } from '../hooks/usePersistedState';
import { useRemoteAnswer } from '../hooks/useRemoteAnswer';
import { useSessions } from '../hooks/useSessions';
import type { FocusClaim } from '../hooks/useFocusWatch';
import { useSettings } from '../hooks/useSettings';
import { useWebNotify } from '../hooks/useWebNotify';
import { applyView, clearFilters, describeEmpty, pruneProjects, DEFAULT_VIEW, type View } from '../lib/filterSort';
import { formatInterval } from '../lib/settings';

/** Own chunk — the drawer only loads the first time a chat is opened. */
const ChatDrawer = lazy(() => import('./ChatDrawer'));
/** Own chunk, same reasoning — most sessions never spawn one of these. */
const SpawnPanel = lazy(() => import('./SpawnPanel'));

export interface SessionsViewProps {
  /**
   * A desk notification the user tapped, claimed by the app shell. Owned up
   * there rather than here precisely because this component stops polling the
   * moment another section is opened — see `useFocusWatch`.
   */
  focus: FocusClaim | null;
  /** Called once the claim has opened its drawer, so it cannot be applied twice. */
  onFocusApplied: () => void;
}

/**
 * The live sessions monitor — the app's original single view. Owns the 3s
 * poll (useSessions), so switching to the Management section unmounts it and
 * stops polling.
 */
export function SessionsView({ focus, onFocusApplied }: SessionsViewProps) {
  const { data, connected } = useSessions();
  const { settings } = useSettings();
  const [view, setView] = usePersistedState<View>('dashboard.view', DEFAULT_VIEW);
  // Not persisted: session ids churn, so a restored selection would be stale
  // (same reasoning as row expansion — see docs/subsystems/view-persistence.md).
  // Seeded from a `?session=` deep link, which is consumed once and stripped.
  const [chatId, setChatId] = useState<string | null>(() => deepLinkSession());
  // Not persisted either: a one-shot form, not a view setting.
  const [spawnOpen, setSpawnOpen] = useState(false);
  // One `/api/health` poll, owned here so both the toolbar (badge, switch,
  // "+ New" gate) and the spawn panel (its permission-mode ceiling) read the
  // same snapshot instead of each starting their own.
  const remoteAnswer = useRemoteAnswer();
  // Rides this view's poll, so it is bound to it: nothing announces while
  // another section is open. See docs/subsystems/push-notify.md.
  useWebNotify(data?.sessions);

  // A tapped desk notification, handed over server-side (see
  // server/lib/focus.ts). Unlike the `?session=` deep link this arrives at a page
  // that is already open, so it only opens the drawer — the URL is left alone.
  //
  // Keyed on `focus`, which the shell replaces with a new object per claim: the
  // id alone would not re-open the drawer for a second tap on the same session,
  // and depending on the whole poll payload would re-fire every tick with a
  // stale id and make the drawer impossible to close.
  useEffect(() => {
    if (!focus) return;
    setChatId(focus.id);
    // Hand it back as spent. The shell outlives this component, so a claim left
    // standing would re-open the drawer on every remount — i.e. every time you
    // visit another section and come back.
    onFocusApplied();
  }, [focus, onFocusApplied]);

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

  const chatSession = chatId && data ? data.sessions.find(s => s.id === chatId) : undefined;

  return (
    <>
      <Header data={data} />
      <Toolbar
        sessions={data ? data.sessions : []}
        view={view}
        onChange={setView}
        onOpenSpawn={() => setSpawnOpen(true)}
        remoteAnswer={remoteAnswer}
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
      <SessionList
        sessions={shown}
        empty={empty}
        onClearFilters={() => setView(clearFilters(view))}
        launching={data?.launching}
        onOpenChat={setChatId}
      />
      <div className="foot">
        {connected
          ? `live · refreshing every ${formatInterval(settings.refreshMs)}`
          : <span className="off">disconnected — server stopped?</span>}
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
    </>
  );
}
