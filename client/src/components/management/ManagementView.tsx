import { useSettings } from '../../hooks/useSettings';
import GitView from './GitView';
import ProjectsView from './ProjectsView';

/**
 * The Management section: two sub-views, **Projects** and **Git**.
 *
 * Which one is showing is the per-device `managementTab`, picked from the
 * rail's tree at every width — the same swap Usage and Settings make, so there
 * is no switch on the page itself. Projects is the default, and what a click
 * on Management in the rail lands on (the first item of its tree).
 *
 * Git is the local state of the pinned repos (`GitView`, which owns the poll,
 * so showing Projects stops it). Projects is the project ledger that
 * used to be Settings › Pinned (`ProjectsView`: Tiles, Columns or Lists) — a
 * list that grows with use belongs next to the repos it feeds, not among the
 * policies.
 *
 * Default export → its own lazy chunk, like every section but Sessions.
 */
export default function ManagementView() {
  const { settings } = useSettings();

  return settings.managementTab === 'projects' ? <ProjectsView /> : <GitView />;
}
