import { lazy, Suspense, useMemo, useState } from 'react';

import { Header } from './Header';
import { SessionList } from './SessionList';
import { Toolbar } from './Toolbar';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSessions } from '../hooks/useSessions';
import { applyView, DEFAULT_VIEW, type View } from '../lib/filterSort';

/** Own chunk — the drawer only loads the first time a chat is opened. */
const ChatDrawer = lazy(() => import('./ChatDrawer'));

/**
 * The live sessions monitor — the app's original single view. Owns the 3s
 * poll (useSessions), so switching to the Management section unmounts it and
 * stops polling.
 */
export function SessionsView() {
  const { data, connected } = useSessions();
  const [view, setView] = usePersistedState<View>('dashboard.view', DEFAULT_VIEW);
  // Not persisted: session ids churn, so a restored selection would be stale
  // (same reasoning as row expansion — see .claude/rules/view-persistence.md).
  const [chatId, setChatId] = useState<string | null>(null);

  const shown = useMemo(
    () => (data ? applyView(data.sessions, view, Date.now()) : null),
    [data, view]
  );

  const chatSession = chatId && data ? data.sessions.find(s => s.id === chatId) : undefined;

  return (
    <>
      <Header data={data} />
      <Toolbar sessions={data ? data.sessions : []} view={view} onChange={setView} />
      <SessionList sessions={shown} onOpenChat={setChatId} />
      <div className="foot">
        {connected
          ? 'live · refreshing every 3s'
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
