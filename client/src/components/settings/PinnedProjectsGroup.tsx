import { useState } from 'react';

import PinPicker from '../PinPicker';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { usePins } from '../../hooks/usePins';
import { lastSessionLabel, shortenHome } from '../../lib/pins';

/**
 * Settings › Pinned (#161): one row per pin with its Unpin,
 * then the picker to add one — every unpinned project, recent ones included, so
 * a project in daily use can be pinned before it ages out of the lookback. Its own component so the
 * `GET /api/pins` scan runs only when the Pinned page is actually open.
 *
 * A dead pin — its folder is gone or is now a linked worktree — is still
 * stored and still listed here, flagged, because this is the one place it can
 * be removed from. The group never disappears: with no pins it says so.
 */
export default function PinnedProjectsGroup() {
  const { pins, busy, setPin } = usePins();
  const [error, setError] = useState<string | null>(null);
  const offered = pins ? [...pins.recent, ...pins.older] : [];

  async function change(dirName: string, pinned: boolean): Promise<string | null> {
    setError(null);
    const failure = await setPin(dirName, pinned);
    if (failure && !pinned) setError(failure);
    return failure;
  }

  return (
    <SettingsGroup title="Pinned projects" sub="Always listed, whatever the lookback">
      {pins === null && <div className="set-row"><span className="set-hint">Loading…</span></div>}
      {pins !== null && pins.pinned.length === 0 && (
        <div className="set-row"><span className="set-hint">No projects are pinned.</span></div>
      )}
      {pins?.pinned.map(row => (
        <SettingsRow
          key={row.dirName}
          name={row.name}
          hint={
            <>
              {row.path !== null && <>{shortenHome(row.path, pins.home)}</>}
              {row.listed
                ? row.lastActiveMs !== null && <> · {lastSessionLabel(row.lastActiveMs)}</>
                : <>{row.path !== null && ' · '}folder no longer exists — hidden from every list</>}
            </>
          }
        >
          <button type="button" disabled={busy !== null} onClick={() => void change(row.dirName, false)}>
            {busy === row.dirName ? 'Unpinning…' : 'Unpin'}
          </button>
        </SettingsRow>
      ))}
      {error && (
        <div className="set-warn">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}
      {pins !== null && (
        <SettingsRow
          name="Pin another project"
          hint={
            offered.length > 0
              ? 'Every project with a session in the last 30 days, newest first. Pick one to pin it.'
              : 'Every project active in the last 30 days is already pinned.'
          }
          below={
            offered.length > 0 && (
              <PinPicker projects={offered} home={pins.home} busy={busy} onPin={d => change(d, true)} />
            )
          }
        />
      )}
    </SettingsGroup>
  );
}
