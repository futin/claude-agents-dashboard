import { Suspense, lazy } from 'react';

import { useGitFetch } from '../../hooks/useGitFetch';
import { useGitStats } from '../../hooks/useGitStats';
import { useGitSync, type GitSyncControl } from '../../hooks/useGitSync';
import type { FetchClock, GitStatsResponse } from '../../../../shared/types';
import { useNarrow } from '../../hooks/useNarrow';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useSettings } from '../../hooks/useSettings';
import { DEFAULT_GIT_LAYOUT, drawableGitLayout, gitLayoutsFor, isGitLayout, type GitLayout } from '../../lib/gitLayouts';
import { GIT_BAND_SUB, GIT_NO_PINS, gitFirstLoadText } from '../../lib/gitStatsText';
import { Band } from '../usage/Sheet';
import GitCards from './GitCards';
import GitClockChip from './GitClockChip';
import GitTable from './GitTable';
import GitTriage from './GitTriage';

/** Own chunk, as in SessionsView: most visits never open a sync's chat. */
const ChatDrawer = lazy(() => import('../ChatDrawer'));

/**
 * Management › Git: the band, a toolbar of the Cards | Table | Triage switcher and the Sync/Fetch clock chip, and the layout the switcher picks.
 * The poll lives in `useGitStats`, mounted with this view, so switching to Pinned or leaving the section stops it.
 *
 * The stored layout is per device (`management.gitLayout`); what is drawn is `drawableGitLayout`, so a phone draws Cards while a stored Table survives for
 * the next wide window.
 */
export default function GitView() {
  const stats = useGitStats();
  const { data, error } = stats;
  const sync = useGitSync(stats.refresh);
  const fetchCtl = useGitFetch(sync.tokenRequired, stats.refresh);
  const narrow = useNarrow();
  const [stored, setStored] = usePersistedState<string>('management.gitLayout', DEFAULT_GIT_LAYOUT);
  const layout = drawableGitLayout(isGitLayout(stored) ? stored : DEFAULT_GIT_LAYOUT, narrow);

  return (
    <div className="usage-section git-view">
      <Band title="Management · Git" sub={GIT_BAND_SUB} />
      <div className="git-toolbar">
        <div className="seg git-switch" role="tablist" aria-label="Layout">
          {gitLayoutsFor(narrow).map(l => (
            <button key={l.key} type="button" role="tab" aria-selected={layout === l.key} className={layout === l.key ? 'on' : ''} onClick={() => setStored(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
        {/* Once the first poll has answered, payload or error: a first-load failure still gets the chip, whose Local sync key is the retry. */}
        {(data !== null || error) && <GitClockChip stats={stats} fetchCtl={fetchCtl} tokenRequired={sync.tokenRequired} clock={data?.fetch} />}
      </div>
      {sync.note && <div className="git-sync-note">{sync.note}</div>}
      <GitBody data={data} error={error} layout={layout} sync={sync} clock={data?.fetch} />
      {sync.chat && (
        <Suspense fallback={null}>
          {/* keyed by id, as in SessionsView: another sync's chat remounts the tail cleanly */}
          <ChatDrawer key={sync.chat.id} session={sync.chat} onClose={sync.closeChat} spawnAvailable={sync.available} />
        </Suspense>
      )}
    </div>
  );
}

function GitBody({ data, error, layout, sync, clock }: {
  data: GitStatsResponse | null;
  error: boolean;
  layout: GitLayout;
  sync: GitSyncControl;
  clock: FetchClock | undefined;
}) {
  const { update } = useSettings();
  if (data === null) return <div className="git-empty">{gitFirstLoadText(error)}</div>;
  if (data.repos.length === 0) {
    // The last "Pinned" of the sentence becomes the link to the Pinned sub-view; the rest stays the copy table's text.
    const at = GIT_NO_PINS.lastIndexOf('Pinned');
    return (
      <div className="git-empty">
        {GIT_NO_PINS.slice(0, at)}
        <button type="button" className="git-link" onClick={() => update({ managementTab: 'pinned' })}>Pinned</button>
        {GIT_NO_PINS.slice(at + 'Pinned'.length)}
      </div>
    );
  }
  if (layout === 'table') return <GitTable repos={data.repos} sync={sync} clock={clock} />;
  if (layout === 'triage') return <GitTriage repos={data.repos} sync={sync} clock={clock} />;
  return <GitCards repos={data.repos} sync={sync} clock={clock} />;
}
