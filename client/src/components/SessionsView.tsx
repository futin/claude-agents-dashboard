import { useMemo } from 'react';

import { Header } from './Header';
import { SessionList } from './SessionList';
import { Toolbar } from './Toolbar';
import { usePersistedState } from '../hooks/usePersistedState';
import { useSessions } from '../hooks/useSessions';
import { applyView, DEFAULT_VIEW, type View } from '../lib/filterSort';

/**
 * The live sessions monitor — the app's original single view. Owns the 3s
 * poll (useSessions), so switching to the Management section unmounts it and
 * stops polling.
 */
export function SessionsView() {
  const { data, connected } = useSessions();
  const [view, setView] = usePersistedState<View>('dashboard.view', DEFAULT_VIEW);

  const shown = useMemo(
    () => (data ? applyView(data.sessions, view, Date.now()) : null),
    [data, view]
  );

  return (
    <>
      <Header data={data} />
      <Toolbar sessions={data ? data.sessions : []} view={view} onChange={setView} />
      <SessionList sessions={shown} />
      <div className="foot">
        {connected
          ? 'live · refreshing every 3s'
          : <span className="off">disconnected — server stopped?</span>}
      </div>
    </>
  );
}
