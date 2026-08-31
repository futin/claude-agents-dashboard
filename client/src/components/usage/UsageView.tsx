import { Segmented } from '../settings/SettingsRow';
import { useSettings } from '../../hooks/useSettings';
import type { UsageTab } from '../../lib/settings';
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
 * **Sub-tabs rather than a stack.** `UsageProfile` is a full week of hour cells
 * and runs to about a screen on its own, so putting the rates card under it
 * would bury the shorter, denser view behind a scroll. Only the active sub-view
 * mounts, which also means each one's single-fetch-per-mount hook fires exactly
 * when its tab is opened — not on every visit to the section.
 *
 * The choice persists per device through the same localStorage settings the
 * rest of the app uses: the phone on the desk tends to sit on one of these and
 * the laptop on the other.
 *
 * Default export → its own lazy chunk, like every section but Sessions.
 */

const TABS: { value: UsageTab; label: string }[] = [
  { value: 'forecast', label: 'Forecast' },
  { value: 'rates', label: 'Token value' }
];

const HINTS: Record<UsageTab, string> = {
  forecast: 'the duty cycle behind the weekly projection in the header',
  rates: 'what one percent of the 5-hour window costs, per model'
};

export default function UsageView() {
  const { settings, update } = useSettings();
  const tab = settings.usageTab;

  return (
    <div className="usage-section">
      <div className="an-bar">
        <div className="an-title">Usage</div>
        <span className="an-hint">{HINTS[tab]}</span>
        <div className="usage-tabs">
          <Segmented value={tab} options={TABS} onChange={(v) => update({ usageTab: v })} />
        </div>
      </div>
      {tab === 'forecast' ? <UsageProfile /> : <UsageRates />}
    </div>
  );
}
