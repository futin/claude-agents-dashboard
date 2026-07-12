import { lazy, Suspense } from 'react';

import { SectionTabs, type Section } from './components/SectionTabs';
import { SessionsView } from './components/SessionsView';
import { usePersistedState } from './hooks/usePersistedState';

// Lazy: the management chunk loads only when the section is opened, so the
// sessions view's bundle is unaffected.
const ManagementView = lazy(() => import('./components/management/ManagementView'));

export function App() {
  const [section, setSection] = usePersistedState<Section>('dashboard.section', 'sessions');

  return (
    <div className={section === 'management' ? 'wrap wide' : 'wrap'}>
      <SectionTabs section={section} onChange={setSection} />
      {section === 'sessions' ? (
        <SessionsView />
      ) : (
        <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
          <ManagementView />
        </Suspense>
      )}
    </div>
  );
}
