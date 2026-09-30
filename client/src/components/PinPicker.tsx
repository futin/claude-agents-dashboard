import { useState } from 'react';

import { lastSessionLabel, matchesPinFilter, shortenHome } from '../lib/pins';
import type { ProjectRef } from '../../../shared/types';

interface Props {
  /** The projects on offer, newest-first: `older` in the launch sheet, `recent` + `older` in Settings. */
  projects: ProjectRef[];
  home: string;
  /** The dirName whose request is in flight — its button reads `Pinning…`, the rest wait. */
  busy: string | null;
  /** Resolves null on success, else the reason to show under that row. */
  onPin: (dirName: string) => Promise<string | null>;
}

/**
 * The pin picker (#161): a filter box over name and path, and one
 * row per match — name, `~` path, last-session age, **Pin**. Enter pins the
 * first match. Shared by the launch sheet and Settings › Pinned, so both offer
 * pins the same way. A refusal shows inline under its row and changes nothing.
 */
export default function PinPicker({ projects, home, busy, onPin }: Props) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);
  const matches = projects.filter(r => matchesPinFilter(r, query));

  async function pin(dirName: string): Promise<void> {
    if (busy) return;
    setError(null);
    const text = await onPin(dirName);
    if (text) setError({ dirName, text });
    else setQuery('');
  }

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
            void pin(matches[0].dirName);
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="pin-list">
          {matches.map(r => (
            <li key={r.dirName} className="pin-row">
              <span className="pin-text">
                <span className="pin-name">{r.name}</span>
                <span className="pin-meta">{shortenHome(r.path, home)} · {lastSessionLabel(r.lastActiveMs)}</span>
                {error?.dirName === r.dirName && <span className="pin-meta sp-error">{error.text}</span>}
              </span>
              <button type="button" className="qp-term" disabled={busy !== null} onClick={() => void pin(r.dirName)}>
                {busy === r.dirName ? 'Pinning…' : 'Pin'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() !== '' && matches.length === 0 && <span className="sp-note">No project matches.</span>}
    </div>
  );
}
