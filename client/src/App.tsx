import { lazy, Suspense, useEffect, useState } from 'react';

import { SideRail } from './components/SideRail';
import { SessionsView } from './components/SessionsView';
import { deepLinkSession } from './lib/deepLink';
import { isSection, type Section } from './lib/sections';
import { useFocusWatch } from './hooks/useFocusWatch';
import { usePersistedState } from './hooks/usePersistedState';
import { SettingsProvider, useSettings } from './hooks/useSettings';

// Lazy: these chunks load only when their section is opened, so the sessions
// view's bundle is unaffected.
const ManagementView = lazy(() => import('./components/management/ManagementView'));
const AnalyticsView = lazy(() => import('./components/analytics/AnalyticsView'));
const UsageView = lazy(() => import('./components/usage/UsageView'));
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
  // `isSection` filters a value left over from a release that had a section
  // this one doesn't (the removed Guides tab), which would otherwise render
  // the final `else` branch — Settings — instead of the sessions list.
  const [section, setSection] = useState<Section>(() => {
    if (deepLinkSession()) return 'sessions';
    const want = settings.landing === 'last' ? stored : settings.landing;
    return isSection(want) ? want : 'sessions';
  });

  // A tapped desk notification, watched on every section — see useFocusWatch for
  // why this cannot live in SessionsView. Switching the section here is the same
  // move the `?session=` deep link makes in the initializer above: a tap exists
  // only to put you on that session's chat, so it beats whatever you were
  // looking at.
  const focus = useFocusWatch();
  useEffect(() => {
    if (focus) setSection('sessions');
  }, [focus]);

  const change = (s: Section): void => {
    setSection(s);
    setStored(s);
  };

  // The three-pane management view and the analytics cards need the room;
  // sessions and settings are single-column and read better narrow.
  const wide = section === 'management' || section === 'analytics';

  return (
    <div className="shell">
      <SideRail section={section} onChange={change} />
      <main className="main">
        <div className={wide ? 'wrap wide' : 'wrap'}>
          {section === 'sessions' ? (
            <SessionsView focus={focus} />
          ) : section === 'management' ? (
            <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
              <ManagementView />
            </Suspense>
          ) : section === 'analytics' ? (
            <Suspense fallback={<div className="an-empty">loading…</div>}>
              <AnalyticsView />
            </Suspense>
          ) : section === 'usage' ? (
            <Suspense fallback={<div className="an-empty">loading…</div>}>
              <UsageView />
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
