import { useSettings } from '../../hooks/useSettings';
import { SettingsBand } from '../settings/SettingsRow';
import GitView from './GitView';
import PinnedProjectsGroup from './PinnedProjectsGroup';

/**
 * The Management section: two sub-views, **Git** and **Pinned**.
 *
 * Which one is showing is the per-device `managementTab`, picked from the
 * rail's tree at every width — the same swap Usage and Settings make, so there
 * is no switch on the page itself.
 *
 * Git is the local state of the pinned repos (`GitView`, which owns the poll,
 * so showing Pinned stops it). Pinned is the project ledger that
 * used to be Settings › Pinned, moved here and given drag grips that set the
 * pin order Git draws in — a list that grows with use belongs next to the repos
 * it feeds, not among the policies.
 *
 * Default export → its own lazy chunk, like every section but Sessions.
 */
export default function ManagementView() {
  const { settings } = useSettings();

  if (settings.managementTab === 'pinned') {
    return (
      <div className="set">
        <SettingsBand
          scope="shared"
          title="Management · Pinned"
          sub="Projects that stay in the launch sheet however long ago their last session was. Stored by the dashboard server, so a pin shows up on every device."
        />
        {/* One full-width column: the list grows with every pin, so it gets
            the page to itself rather than half of a two-column grid. */}
        <div className="set-col">
          <PinnedProjectsGroup />
        </div>
      </div>
    );
  }

  return <GitView />;
}
