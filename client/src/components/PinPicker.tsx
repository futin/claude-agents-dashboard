import { useState } from 'react';
import type { ReactNode } from 'react';

import { formatAgo } from '../lib/format';
import { matchesPinFilter, shortenHome, splitPath } from '../lib/pins';
import type { PinRow, ProjectRef } from '../../../shared/types';

interface Props {
  /** The projects on offer, newest-first: `older` in the launch sheet, `recent` + `older` in Settings. */
  projects: ProjectRef[];
  home: string;
  /** The dirName whose request is in flight — its button reads `Pinning…` or `Unpinning…`, the rest wait. */
  busy: string | null;
  /** Resolves null on success, else the reason to show under that row. */
  onPin: (dirName: string) => Promise<string | null>;
  /**
   * Settings › Pinned only: the stored pins, listed above the offers under a
   * heading of their own and filtered by the same box, each with an Unpin.
   * Absent in the launch sheet, which has nowhere to unpin from.
   */
  pinned?: PinRow[];
  onUnpin?: (dirName: string) => Promise<string | null>;
}

type Act = (dirName: string) => Promise<string | null>;

/**
 * The pin picker (#161): a filter box over name and path, then one row per
 * match — the `~` path with its basename as the title, the last-session age,
 * a **Pin** (or, for a stored pin, **Unpin**). Enter pins the first offered
 * match. Shared by the launch sheet and Settings › Pinned, so both offer pins
 * the same way; Settings also hands it the pins, and the one filter runs over
 * both groups. A refusal shows inline under its row and changes nothing. A
 * click never moves a row by hand: the POST answers with the fresh payload
 * and the groups re-split from that.
 */
export default function PinPicker({ projects, home, busy, onPin, pinned, onUnpin }: Props) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);
  const matches = projects.filter(r => matchesPinFilter(r, query));
  const pinnedMatches = (pinned ?? []).filter(r => matchesPinFilter(r, query));

  async function act(dirName: string, fn: Act, clearQuery: boolean): Promise<void> {
    if (busy) return;
    setError(null);
    const text = await fn(dirName);
    if (text) setError({ dirName, text });
    else if (clearQuery) setQuery('');
  }

  const errorFor = (dirName: string): string | null => (error?.dirName === dirName ? error.text : null);
  const offersNote = projects.length === 0
    ? (pinned ? 'Every project active in the last 30 days is already pinned.' : null)
    : matches.length === 0 ? 'No project matches.' : null;

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
            void act(matches[0].dirName, onPin, true);
          }
        }}
      />
      <div className="pin-head"><span>Project</span><span>Last session</span></div>
      {pinned && onUnpin && (
        <>
          <div className="pin-group">Pinned<span className="pin-count">{pinned.length}</span></div>
          {pinnedMatches.length > 0 ? (
            <ul className="pin-list">
              {pinnedMatches.map(row => (
                <PinEntry key={row.dirName} path={row.path} name={row.name} home={home} lastActiveMs={row.lastActiveMs} dead={!row.listed} error={errorFor(row.dirName)}>
                  <button type="button" className="qp-term" disabled={busy !== null} onClick={() => void act(row.dirName, onUnpin, false)}>
                    {busy === row.dirName ? 'Unpinning…' : 'Unpin'}
                  </button>
                </PinEntry>
              ))}
            </ul>
          ) : (
            <span className="sp-note">{pinned.length === 0 ? 'No projects are pinned.' : 'No pinned project matches.'}</span>
          )}
          <div className="pin-group">Not pinned<span className="pin-count">{projects.length}</span></div>
        </>
      )}
      {matches.length > 0 && (
        <ul className="pin-list">
          {matches.map(r => (
            <PinEntry key={r.dirName} path={r.path} name={r.name} home={home} lastActiveMs={r.lastActiveMs} error={errorFor(r.dirName)}>
              <button type="button" className="qp-term" disabled={busy !== null} onClick={() => void act(r.dirName, onPin, true)}>
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
 * one still wraps inside itself). A dead pin, or a refused click, gets a line
 * under the path; the age column stays blank when no session is left to date.
 */
function PinEntry({
  path, name, home, lastActiveMs, dead, error, children
}: {
  path: string | null; name: string; home: string; lastActiveMs: number | null;
  dead?: boolean; error: string | null; children: ReactNode;
}) {
  const shown = path === null ? { dirs: [], name } : splitPath(shortenHome(path, home));
  return (
    <li className="pin-row">
      <span className="pin-path">
        {shown.dirs.map((d, i) => <span key={i} className="pin-seg">{d}</span>)}
        <b>{shown.name}</b>
        {dead && <span className="pin-sub">Folder no longer exists. Hidden from every list until unpinned.</span>}
        {error && <span className="pin-sub err">{error}</span>}
      </span>
      <span className="pin-age">{lastActiveMs === null ? '' : `${formatAgo(lastActiveMs)} ago`}</span>
      {children}
    </li>
  );
}
