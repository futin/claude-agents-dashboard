import { useSettings } from '../../hooks/useSettings';
import type { UsageTab } from '../../lib/settings';
import { Band } from './Sheet';
import { UsageProfile } from './UsageProfile';
import { UsageRates } from './UsageRates';

/**
 * The Usage section — what the dashboard has learned about your account usage,
 * and what it predicts from it.
 *
 * Its own rail entry rather than a block inside Analytics: Analytics is about
 * *sessions* (the `/kaizen` report cards), and this is about the *account*. They
 * share no data, no endpoint and no cadence — Analytics re-reads transcripts,
 * this reads a profile that moves once a week.
 *
 * **Sub-views rather than a stack.** Each tab runs to several sheets on its own,
 * so stacking them would bury whichever one you did not come for behind a
 * scroll. Only the active sub-view mounts, which also means each one's
 * single-fetch-per-mount hook fires exactly when its tab is opened — not on
 * every visit to the section.
 *
 * The choice persists per device through the same localStorage settings the
 * rest of the app uses: the phone on the desk tends to sit on one of these and
 * the laptop on the other.
 *
 * **The switch lives in the nav, not on the page.** These are two views of the
 * section, which makes them navigation: they are the tree under Usage in
 * `SideRail`, on the desktop rail and in the phone menu alike. The page used to
 * carry a phone-only copy of it, from when the phone nav was a horizontal strip
 * that could not draw a tree; the menu draws one, so there is one control.
 *
 * Default export → its own lazy chunk, like every section but Sessions.
 */

const TABS: { value: UsageTab; label: string }[] = [
  { value: 'forecast', label: 'Forecast' },
  { value: 'rates', label: 'Token value' }
];

const SUBS: Record<UsageTab, string> = {
  forecast: 'The duty cycle behind the weekly projection in the header · recorded on this '
    + 'machine, folded weekly',
  rates: 'What one percent of the 5-hour window costs, per model · measured on this machine only'
};

export default function UsageView() {
  const { settings } = useSettings();
  const tab = settings.usageTab;

  return (
    <div className="usage-section">
      <Band title={`Usage · ${TABS.find(t => t.value === tab)!.label}`} sub={SUBS[tab]} />
      {tab === 'forecast' ? <UsageProfile /> : <UsageRates />}
    </div>
  );
}
