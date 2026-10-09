import { useState } from 'react';
import type { ReactNode } from 'react';

import { formatAgo } from '../lib/format';
import { matchesPinFilter, shortenHome, splitPath } from '../lib/pins';
import type { ProjectRef } from '../../../shared/types';

interface Props {
  /** The projects on offer, newest-first: the launch sheet's `older`. */
  projects: ProjectRef[];
  home: string;
  /** The dirName whose request is in flight — its button reads `Pinning…`, the rest wait. */
  busy: string | null;
  /** Resolves null on success, else the reason to show under that row. */
  onPin: (dirName: string) => Promise<string | null>;
}

/**
 * The launch sheet's pin picker (#161): a filter box over name and path, then
 * one row per match — the `~` path with its basename as the title, the
 * last-session age, a **Pin**. Enter pins the first match. A refusal shows
 * inline under its row and changes nothing. A click never moves a row by
 * hand: the POST answers with the fresh payload and the list re-splits from
 * that. Management › Projects does not use it; it draws its own tiles.
 */
export default function PinPicker({ projects, home, busy, onPin }: Props) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);
  const matches = projects.filter(r => matchesPinFilter(r, query));

  async function act(dirName: string): Promise<void> {
    if (busy) return;
    setError(null);
    const text = await onPin(dirName);
    if (text) setError({ dirName, text });
    else setQuery('');
  }

  const errorFor = (dirName: string): string | null => (error?.dirName === dirName ? error.text : null);
  const offersNote = projects.length > 0 && matches.length === 0 ? 'No project matches.' : null;

  return (
    <div className="pin-pick">
      <input
        className="qp-other"
        type="text"
        placeholder="Filter by name or path"
        aria-label="Filter projects"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && matches.length > 0) {
            e.preventDefault();
            void act(matches[0].dirName);
          }
        }}
      />
      <div className="pin-head"><span>Project</span><span>Last session</span></div>
      {matches.length > 0 && (
        <ul className="pin-list">
          {matches.map(r => (
            <PinEntry key={r.dirName} path={r.path} name={r.name} home={home} lastActiveMs={r.lastActiveMs} error={errorFor(r.dirName)}>
              <button type="button" className="qp-term" disabled={busy !== null} onClick={() => void act(r.dirName)}>
                {busy === r.dirName ? 'Pinning…' : 'Pin'}
              </button>
            </PinEntry>
          ))}
        </ul>
      )}
      {offersNote && <span className="sp-note">{offersNote}</span>}
    </div>
  );
}

/**
 * One row. The path is the title: parents dim, basename bright, each segment
 * an atomic inline so a line breaks only between segments (a lone over-long
 * one still wraps inside itself). A refused click gets a line under the path;
 * the age column stays blank when no session is left to date.
 */
function PinEntry({
  path, name, home, lastActiveMs, error, children
}: {
  path: string | null; name: string; home: string; lastActiveMs: number | null;
  error: string | null; children: ReactNode;
}) {
  const shown = path === null ? { dirs: [], name } : splitPath(shortenHome(path, home));
  return (
    <li className="pin-row">
      <span className="pin-path">
        {shown.dirs.map((d, i) => <span key={i} className="pin-seg">{d}</span>)}
        <b>{shown.name}</b>
        {error && <span className="pin-sub err">{error}</span>}
      </span>
      <span className="pin-age">{lastActiveMs === null ? '' : `${formatAgo(lastActiveMs)} ago`}</span>
      {children}
    </li>
  );
}
