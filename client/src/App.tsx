import { Header } from './components/Header';
import { SessionList } from './components/SessionList';
import { useSessions } from './hooks/useSessions';

export function App() {
  const { data, connected } = useSessions();

  return (
    <div className="wrap">
      <Header data={data} />
      <SessionList sessions={data ? data.sessions : null} />
      <div className="foot">
        {connected
          ? 'live · refreshing every 3s'
          : <span className="off">disconnected — server stopped?</span>}
      </div>
    </div>
  );
}
