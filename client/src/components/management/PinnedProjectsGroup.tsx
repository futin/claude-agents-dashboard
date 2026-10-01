import PinPicker from '../PinPicker';
import { SettingsGroup } from '../settings/SettingsRow';
import { usePins } from '../../hooks/usePins';

/**
 * Management › Pinned (#161, moved here from Settings): one card, one ledger — every project with a
 * session in the last 30 days, the stored pins under a heading of their own
 * with an Unpin each, the rest under another with a Pin each, one filter over
 * both. Its own component so the `GET /api/pins` scan runs only when the
 * Pinned page is actually open.
 *
 * A dead pin — its folder is gone or is now a linked worktree — is still
 * stored and still listed here, flagged, because this is the one place it can
 * be removed from. The card never disappears: with no pins it says so.
 */
export default function PinnedProjectsGroup() {
  const { pins, busy, setPin } = usePins();
  return (
    <SettingsGroup title="Projects" sub="Everything with a session in the last 30 days. Pin a project and it stays listed whatever the lookback.">
      {pins === null ? (
        <div className="set-row"><span className="set-hint">Loading…</span></div>
      ) : (
        <PinPicker
          projects={[...pins.recent, ...pins.older]}
          pinned={pins.pinned}
          home={pins.home}
          busy={busy}
          onPin={d => setPin(d, true)}
          onUnpin={d => setPin(d, false)}
        />
      )}
    </SettingsGroup>
  );
}
