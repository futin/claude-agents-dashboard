import { useEffect } from 'react';

import type { Release, ReleasesResponse } from '../../../shared/types';
import { useBackClose } from '../hooks/useBackClose';
import { badges, chipLabel, displayTitle, formatReleaseDate } from '../lib/releases';
import { Markdown } from './Markdown';

function Entry({ r }: { r: Release }) {
  // The baseline is where numbering starts, not something that shipped: a divider, no badges, no title.
  if (r.type === 'baseline') {
    return <div className="rel-entry"><div className="rel-base">Versioning starts here · v{r.version}</div></div>;
  }
  return (
    <div className="rel-entry">
      <div className="rel-row">
        <span className="rel-ver">v{r.version}</span>
        {badges(r).map(b => <span key={b.kind} className={`rel-badge ${b.kind}`}>{b.label}</span>)}
        <span className="spacer" />
        <span className="rel-date">{formatReleaseDate(r.date)}</span>
      </div>
      <div className="rel-title">{displayTitle(r.title)}</div>
      {r.notes !== '' && <Markdown text={r.notes} />}
      {r.url && r.pr !== undefined && (
        <a className="rel-pr" href={r.url} target="_blank" rel="noreferrer noopener">PR #{r.pr}</a>
      )}
    </div>
  );
}

/**
 * The What's new drawer (docs/subsystems/releases.md): every release newest first, from the version chip at the rail's foot. Rendered by `AppShell`, not
 * inside the rail, because `.nav.hid` hides the rail with a `transform`, and a transformed ancestor would turn this `position:fixed` panel into one
 * positioned inside the rail. Scrim, ✕, Escape and the phone's back gesture all close it.
 */
export function ReleasesDrawer({ data, onClose }: { data: ReleasesResponse; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Below `md` (768px) the drawer is full screen with no scrim to tap, so back is the other exit, as for the chat drawer.
  useBackClose(onClose);

  const running = chipLabel(data.current);
  return (
    <div className="rel-back" onClick={onClose}>
      <aside className="rel-drawer" role="dialog" aria-label="What's new" onClick={e => e.stopPropagation()}>
        <div className="rel-head">
          <span className="rel-head-t">What's new</span>
          {running && <span className="rel-head-s">running {running}</span>}
          <span className="spacer" />
          <button type="button" className="chat-x" onClick={onClose} aria-label="Close" autoFocus>✕</button>
        </div>
        <div className="rel-list">
          {data.releases.map(r => <Entry key={r.version} r={r} />)}
        </div>
      </aside>
    </div>
  );
}
