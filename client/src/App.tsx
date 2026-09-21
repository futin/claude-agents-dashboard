import { lazy, Suspense, useState } from 'react';

import { SideRail } from './components/SideRail';
import { SessionsView } from './components/SessionsView';
import { deepLinkSession } from './lib/deepLink';
import { isSection, type Section } from './lib/sections';
import { usePersistedState } from './hooks/usePersistedState';
import { ManagementScopeProvider } from './hooks/useManagementScope';
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

  const change = (s: Section): void => {
    setSection(s);
    setStored(s);
  };

  // The analytics cards are an app shell — `wide` pins them to the viewport and
  // the tab scrolls. Settings, Sessions and Usage want the same width for their
  // columns but scroll as a page, so they get `broad`: width only. Usage on the
  // plain 820px `.wrap` read as a different app from Sessions sitting next to it
  // in the rail. `wide-mgmt` is that same width and opts Management *out* of the
  // pinning: its three columns size to their content and the page body is the
  // single scroller, so a long file is read by scrolling the page.
  const broad = section === 'settings' || section === 'sessions' || section === 'usage';
  const wrap = section === 'management' ? 'wrap wide wide-mgmt'
    : section === 'analytics' ? 'wrap wide'
    : broad ? 'wrap broad' : 'wrap';

  // Management's scope is a rail destination now (DESIGN.md §8.5), so the rail
  // and the page share one state and one `/api/management` fetch. `active` is
  // unconditional because the phone menu draws every tree from the first paint,
  // Management's among them: the scan happens once on load instead of on
  // entering the section, and ↻ in the band is what re-runs it.
  return (
    <ManagementScopeProvider active>
      <div className="shell">
        <SideRail section={section} onChange={change} />
        <main className="main">
          <div className={wrap}>
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
    </ManagementScopeProvider>
  );
}
