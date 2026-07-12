import { lazy, Suspense } from 'react';

import { SectionTabs, type Section } from './components/SectionTabs';
import { SessionsView } from './components/SessionsView';
import { usePersistedState } from './hooks/usePersistedState';

// Lazy: these chunks load only when their section is opened, so the sessions
// view's bundle is unaffected.
const ManagementView = lazy(() => import('./components/management/ManagementView'));
const AnalyticsView = lazy(() => import('./components/analytics/AnalyticsView'));

export function App() {
  const [section, setSection] = usePersistedState<Section>('dashboard.section', 'sessions');

  const wide = section === 'management' || section === 'analytics';

  return (
    <div className={wide ? 'wrap wide' : 'wrap'}>
      <SectionTabs section={section} onChange={setSection} />
      {section === 'sessions' ? (
        <SessionsView />
      ) : section === 'management' ? (
        <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
          <ManagementView />
        </Suspense>
      ) : (
        <Suspense fallback={<div className="an-empty">loading…</div>}>
          <AnalyticsView />
        </Suspense>
      )}
    </div>
  );
}
