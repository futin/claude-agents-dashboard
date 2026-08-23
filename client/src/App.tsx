import { lazy, Suspense, useState } from 'react';

import { SideRail, type Section } from './components/SideRail';
import { SessionsView } from './components/SessionsView';
import { deepLinkSession } from './lib/deepLink';
import { usePersistedState } from './hooks/usePersistedState';
import { SettingsProvider, useSettings } from './hooks/useSettings';

// Lazy: these chunks load only when their section is opened, so the sessions
// view's bundle is unaffected.
const ManagementView = lazy(() => import('./components/management/ManagementView'));
const AnalyticsView = lazy(() => import('./components/analytics/AnalyticsView'));
const GuidesView = lazy(() => import('./components/guides/GuidesView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));

export function App() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  );
}

/**
 * Inside the provider so the landing preference is readable before the first
 * paint of a section — `useSettings` can't be called in `App` itself.
 */
function AppShell() {
  const { settings } = useSettings();
  const [stored, setStored] = usePersistedState<Section>('dashboard.section', 'sessions');
  // A `landing` other than 'last' pins the opening tab. Resolved once, in the
  // initializer, so there's no flash of the previously-open section; after that
  // navigation is normal and the last section is still remembered for next time.
  // A `?session=` deep link — a tapped push notification — beats both: it exists
  // only to put you on that session's chat.
  const [section, setSection] = useState<Section>(() =>
    deepLinkSession() ? 'sessions' : settings.landing === 'last' ? stored : settings.landing
  );

  const change = (s: Section): void => {
    setSection(s);
    setStored(s);
  };

  // The three-pane management view, the analytics cards, and the guides
  // list/viewer need the room; sessions and settings are single-column and
  // read better narrow.
  const wide = section === 'management' || section === 'analytics' || section === 'guides';

  return (
    <div className="shell">
      <SideRail section={section} onChange={change} />
      <main className="main">
        <div className={wide ? 'wrap wide' : 'wrap'}>
          {section === 'sessions' ? (
            <SessionsView />
          ) : section === 'management' ? (
            <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
              <ManagementView />
            </Suspense>
          ) : section === 'analytics' ? (
            <Suspense fallback={<div className="an-empty">loading…</div>}>
              <AnalyticsView />
            </Suspense>
          ) : section === 'guides' ? (
            <Suspense fallback={<div className="guides-empty">loading…</div>}>
              <GuidesView />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
              <SettingsView />
            </Suspense>
          )}
        </div>
      </main>
    </div>
  );
}
