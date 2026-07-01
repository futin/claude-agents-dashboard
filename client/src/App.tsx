import { useMemo, useState } from 'react';

import { Header } from './components/Header';
import { SessionList } from './components/SessionList';
import { Toolbar } from './components/Toolbar';
import { useSessions } from './hooks/useSessions';
import { applyView, DEFAULT_VIEW } from './lib/filterSort';

export function App() {
  const { data, connected } = useSessions();
  const [view, setView] = useState(DEFAULT_VIEW);

  const shown = useMemo(
    () => (data ? applyView(data.sessions, view, Date.now()) : null),
    [data, view]
  );

  return (
    <div className="wrap">
      <Header data={data} />
      <Toolbar sessions={data ? data.sessions : []} view={view} onChange={setView} />
      <SessionList sessions={shown} />
      <div className="foot">
        {connected
          ? 'live · refreshing every 3s'
          : <span className="off">disconnected — server stopped?</span>}
      </div>
    </div>
  );
}
