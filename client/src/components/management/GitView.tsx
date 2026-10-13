import { Suspense, lazy, useState } from 'react';

import { useGitFetch } from '../../hooks/useGitFetch';
import { useGitStats } from '../../hooks/useGitStats';
import { useGitSync } from '../../hooks/useGitSync';
import type { GitStatsResponse } from '../../../../shared/types';
import { useNarrow } from '../../hooks/useNarrow';
import { useOpenFolder } from '../../hooks/useOpenFolder';
import { usePersistedState } from '../../hooks/usePersistedState';
import { usePins } from '../../hooks/usePins';
import { useSessions } from '../../hooks/useSessions';
import { useSettings } from '../../hooks/useSettings';
import { DEFAULT_GIT_LAYOUT, drawableGitLayout, gitLayoutsFor, parseGitLayout, type GitLayout } from '../../lib/gitLayouts';
import { SYNC_SCAN_LIMIT } from '../../lib/gitSync';
import { GIT_BAND_SUB, GIT_NO_PINS, gitFirstLoadText } from '../../lib/gitStatsText';
import { Band } from '../usage/Sheet';
import GitClockChip from './GitClockChip';
import GitInbox from './GitInbox';
import GitMatrix from './GitMatrix';
import GitTriage from './GitTriage';
import type { GitLayoutProps } from './gitLayoutProps';

/** Own chunk, as in SessionsView: most visits never open a sync's chat. */
const ChatDrawer = lazy(() => import('../ChatDrawer'));

/**
 * Management › Git: the band, a toolbar of the Inbox | Matrix | Inspector | Branches switcher and the Sync/Fetch clock chip, and the layout the switcher picks.
 * The poll lives in `useGitStats`, mounted with this view, so switching to Projects or leaving the section stops it.
 *
 * The live sessions payload rides along (`useSessions`) so a layout can join agents to branches, as do Unpin (`usePins`, over the shared pins endpoint) and
 * Open folder (`useOpenFolder`); each layout gets all of it through one `GitLayoutProps`, and their failure notes show under the toolbar beside Sync's.
 *
 * The stored layout is per device (`management.gitLayout`); what is drawn is `drawableGitLayout(parseGitLayout(stored))`, so a stored `cards`, `table` or
 * `triage` reads as Inbox and a phone draws Inbox while a stored Matrix survives for the next wide window.
 */
export default function GitView() {
  const stats = useGitStats();
  const { data, error } = stats;
  const sync = useGitSync(stats.refresh);
  const fetchCtl = useGitFetch(sync.tokenRequired, stats.refresh);
  const narrow = useNarrow();
  const [stored, setStored] = usePersistedState<string>('management.gitLayout', DEFAULT_GIT_LAYOUT);
  const layout = drawableGitLayout(parseGitLayout(stored), narrow);
  const sessionsState = useSessions({ limit: SYNC_SCAN_LIMIT });
  const sessions = sessionsState.data?.sessions ?? [];
  const pins = usePins();
  const [unpinNote, setUnpinNote] = useState<string | null>(null);
  const folder = useOpenFolder();

  const unpin = {
    busy: pins.busy,
    run: (dirName: string) => {
      if (pins.busy !== null) return;
      void pins.setPin(dirName, false).then(note => {
        setUnpinNote(note);
        if (note === null) stats.refresh();
      });
    },
  };
  const props: GitLayoutProps = {
    repos: data?.repos ?? [], sessions, nowMs: Date.now(), clock: data?.fetch, sync, fetchCtl, unpin, openFolder: folder.open, narrow, setLayout: setStored,
  };

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
      {unpinNote && <div className="git-sync-note">{unpinNote}</div>}
      {folder.note && <div className="git-sync-note">{folder.note}</div>}
      <GitBody data={data} error={error} layout={layout} props={props} />
      {sync.chat && (
        <Suspense fallback={null}>
          {/* keyed by id, as in SessionsView: another sync's chat remounts the tail cleanly */}
          <ChatDrawer key={sync.chat.id} session={sync.chat} onClose={sync.closeChat} spawnAvailable={sync.available} />
        </Suspense>
      )}
    </div>
  );
}

function GitBody({ data, error, layout, props }: { data: GitStatsResponse | null; error: boolean; layout: GitLayout; props: GitLayoutProps }) {
  const { update } = useSettings();
  if (data === null) return <div className="git-empty">{gitFirstLoadText(error)}</div>;
  if (data.repos.length === 0) {
    // The last "Projects" of the sentence becomes the link to the Projects sub-view; the rest stays the copy table's text.
    const at = GIT_NO_PINS.lastIndexOf('Projects');
    return (
      <div className="git-empty">
        {GIT_NO_PINS.slice(0, at)}
        <button type="button" className="git-link" onClick={() => update({ managementTab: 'projects' })}>Projects</button>
        {GIT_NO_PINS.slice(at + 'Projects'.length)}
      </div>
    );
  }
  if (layout === 'inbox') return <GitInbox {...props} />;
  if (layout === 'matrix') return <GitMatrix {...props} />;
  // Placeholder for the other keys until Tasks 11-12 give each layout its own component; Task 13 deletes GitTriage, so nothing may still draw it by then.
  return <GitTriage repos={props.repos} sync={props.sync} clock={props.clock} />;
}
