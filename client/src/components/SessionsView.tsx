import { lazy, Suspense, useMemo, useState } from 'react';

import { Header } from './Header';
import { SessionList } from './SessionList';
import { Toolbar } from './Toolbar';
import { deepLinkSession } from '../lib/deepLink';
import { usePersistedState } from '../hooks/usePersistedState';
import { useRemoteAnswer } from '../hooks/useRemoteAnswer';
import { useSessions } from '../hooks/useSessions';
import { useSettings } from '../hooks/useSettings';
import { applyView, DEFAULT_VIEW, type View } from '../lib/filterSort';
import { formatInterval } from '../lib/settings';

/** Own chunk — the drawer only loads the first time a chat is opened. */
const ChatDrawer = lazy(() => import('./ChatDrawer'));
/** Own chunk, same reasoning — most sessions never spawn one of these. */
const SpawnPanel = lazy(() => import('./SpawnPanel'));

/**
 * The live sessions monitor — the app's original single view. Owns the 3s
 * poll (useSessions), so switching to the Management section unmounts it and
 * stops polling.
 */
export function SessionsView() {
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

  const shown = useMemo(
    () => (data ? applyView(data.sessions, view, Date.now()) : null),
    [data, view]
  );

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
      <SessionList sessions={shown} launching={data?.launching} onOpenChat={setChatId} />
      <div className="foot">
        {connected
          ? `live · refreshing every ${formatInterval(settings.refreshMs)}`
          : <span className="off">disconnected — server stopped?</span>}
      </div>
      {chatSession && (
        <Suspense fallback={null}>
          {/* keyed by id: switching sessions remounts the tail cleanly */}
          <ChatDrawer key={chatSession.id} session={chatSession} onClose={() => setChatId(null)} />
        </Suspense>
      )}
    </>
  );
}
