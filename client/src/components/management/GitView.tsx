import { useEffect, useState } from 'react';

import { useGitStats } from '../../hooks/useGitStats';
import type { GitStatsResponse } from '../../../../shared/types';
import { useNarrow } from '../../hooks/useNarrow';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useSettings } from '../../hooks/useSettings';
import { formatAgo } from '../../lib/format';
import { DEFAULT_GIT_LAYOUT, drawableGitLayout, gitLayoutsFor, isGitLayout, type GitLayout } from '../../lib/gitLayouts';
import { GIT_NO_PINS, GIT_UPDATE_FAILED, gitFirstLoadText } from '../../lib/gitStatsText';
import { Band } from '../usage/Sheet';
import GitCards from './GitCards';
import GitTable from './GitTable';
import GitTriage from './GitTriage';

/**
 * Management › Git: the band (with "updated Ns ago" / "couldn't update" and ↻ on its right), the Cards | Table | Triage switcher, and the layout it picks.
 * The poll lives in `useGitStats`, mounted with this view, so switching to Pinned or leaving the section stops it.
 *
 * The stored layout is per device (`management.gitLayout`); what is drawn is `drawableGitLayout`, so a phone draws Cards while a stored Table survives for
 * the next wide window.
 */
export default function GitView() {
  const { data, error, updatedAt, refresh } = useGitStats();
  const narrow = useNarrow();
  const [stored, setStored] = usePersistedState<string>('management.gitLayout', DEFAULT_GIT_LAYOUT);
  const layout = drawableGitLayout(isGitLayout(stored) ? stored : DEFAULT_GIT_LAYOUT, narrow);

  return (
    <div className="usage-section git-view">
      <Band
        title="Management · Git"
        sub={'Local state of your pinned repos. Nothing here fetches — "fetched" says how old the remote data is.'}
        right={<GitBandStatus failed={error && data !== null} updatedAt={updatedAt} onRefresh={refresh} />}
      />
      <div className="seg git-switch" role="tablist" aria-label="Layout">
        {gitLayoutsFor(narrow).map(l => (
          <button key={l.key} type="button" role="tab" aria-selected={layout === l.key} className={layout === l.key ? 'on' : ''} onClick={() => setStored(l.key)}>
            {l.label}
          </button>
        ))}
      </div>
      <GitBody data={data} error={error} layout={layout} />
    </div>
  );
}

/** The band's right slot. Re-renders every second while mounted so the age moves between polls. */
function GitBandStatus({ failed, updatedAt, onRefresh }: { failed: boolean; updatedAt: number | null; onRefresh: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick(n => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="git-band-act">
      {failed
        ? <span className="git-band-off">{GIT_UPDATE_FAILED}</span>
        : updatedAt !== null && <span>updated {formatAgo(updatedAt)} ago</span>}
      <button type="button" className="icon-refresh" onClick={onRefresh} aria-label="Refresh now">↻</button>
    </div>
  );
}

function GitBody({ data, error, layout }: {
  data: GitStatsResponse | null;
  error: boolean;
  layout: GitLayout;
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
  if (layout === 'table') return <GitTable repos={data.repos} />;
  if (layout === 'triage') return <GitTriage repos={data.repos} />;
  return <GitCards repos={data.repos} />;
}
