import { useState } from 'react';

import { NumberField, Segmented, SettingsGroup, SettingsRow } from './SettingsRow';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useRemoteAnswer } from '../../hooks/useRemoteAnswer';
import { alertPermission, requestAlertPermission } from '../../hooks/useSessionAlerts';
import { useServerSettings } from '../../hooks/useServerSettings';
import { useSettings } from '../../hooks/useSettings';
import {
  FONT_SCALES, LIMITS, REFRESH_CHOICES, THEMES,
  formatInterval, type Landing, type ThemeId
} from '../../lib/settings';

/**
 * Preview colors per theme — board / strip / accent, in that order. A mirror of
 * the `[data-theme]` blocks in styles.css, kept here because it is presentation:
 * the swatch has to paint a palette that is NOT currently applied, so it can't
 * read the live custom properties.
 */
const SWATCHES: Record<ThemeId, [string, string, string]> = {
  midnight: ['#0c1220', '#182238', '#55d0dd'],
  graphite: ['#111214', '#1f2124', '#6fc5cf'],
  amber: ['#0a0805', '#1a150c', '#ffb03a'],
  nightshift: ['#07120d', '#12251b', '#4fe09a'],
  daylight: ['#e8e3d7', '#fbf8f1', '#136d78']
};

const LANDINGS: { value: Landing; label: string }[] = [
  { value: 'last', label: 'Last used' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'management', label: 'Management' },
  { value: 'analytics', label: 'Analytics' }
];

/**
 * The Settings section.
 *
 * Two storage backends behind one page, and the copy says which is which: most
 * rows are this device only (localStorage), while the Remote group holds the
 * things a separate process — the remote-answer hooks — has to agree on.
 */
export default function SettingsView() {
  const { settings, update, reset } = useSettings();
  const server = useServerSettings();
  const remote = useRemoteAnswer();
  const [token, setToken] = usePersistedState<string>('dashboard.answerToken', '');
  const [permission, setPermission] = useState(alertPermission());
  const [confirmReset, setConfirmReset] = useState(false);

  /** Turning alerts on has to ask the browser first, and only a click may. */
  async function toggleAlerts(next: boolean): Promise<void> {
    if (next) setPermission(await requestAlertPermission());
    update({ alertsEnabled: next });
  }

  return (
    <div className="set">
      <SettingsGroup title="Display · this device">
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Theme</span>
            <span className="set-hint">{THEMES.find(t => t.id === settings.theme)?.hint}</span>
          </div>
        </div>
        <div className="set-themes" style={{ marginTop: 5 }}>
          {THEMES.map(t => (
            <button
              key={t.id}
              className={t.id === settings.theme ? 'set-theme on' : 'set-theme'}
              aria-pressed={t.id === settings.theme}
              onClick={() => update({ theme: t.id })}
            >
              <span className="set-swatch">
                <i style={{ background: SWATCHES[t.id][0] }} />
                <i style={{ background: SWATCHES[t.id][1] }} />
                <i style={{ background: SWATCHES[t.id][2] }} />
              </span>
              <span className="set-theme-name">{t.label}</span>
            </button>
          ))}
        </div>

        <SettingsRow name="Density" hint="Compact tightens row padding and spacing — more sessions per screen.">
          <Segmented
            value={settings.density}
            options={[{ value: 'comfortable' as const, label: 'Comfortable' }, { value: 'compact' as const, label: 'Compact' }]}
            onChange={density => update({ density })}
          />
        </SettingsRow>

        <SettingsRow name="Text size" hint="Scales the whole board, not just type.">
          <Segmented
            value={settings.fontScale}
            options={FONT_SCALES.map(v => ({ value: v, label: `${v}%` }))}
            onChange={fontScale => update({ fontScale })}
          />
        </SettingsRow>

        <SettingsRow name="Opens on" hint="Which section this device lands on when you load the page.">
          <select value={settings.landing} onChange={e => update({ landing: e.target.value as Landing })}>
            {LANDINGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Live data · this device">
        <SettingsRow
          name="Refresh rate"
          hint="How often the sessions list, subagent detail and open chat re-read the transcripts. Faster costs more disk reads, not tokens."
        >
          <select
            value={settings.refreshMs}
            onChange={e => update({ refreshMs: Number(e.target.value) })}
          >
            {REFRESH_CHOICES.map(ms => (
              <option key={ms} value={ms}>every {formatInterval(ms)}</option>
            ))}
          </select>
        </SettingsRow>

        <SettingsRow
          name="Sessions shown"
          hint="Most-recently-active first. Each one costs a transcript tail-read per refresh, so this is the knob that matters on a slow link."
        >
          <NumberField
            value={settings.maxSessions}
            min={LIMITS.maxSessions.min}
            max={LIMITS.maxSessions.max}
            unit="rows"
            onCommit={maxSessions => update({ maxSessions })}
          />
        </SettingsRow>

        <SettingsRow name="Lookback" hint="Ignore sessions whose transcript hasn't changed in this long.">
          <NumberField
            value={settings.lookbackHours}
            min={LIMITS.lookbackHours.min}
            max={LIMITS.lookbackHours.max}
            unit="hours"
            onCommit={lookbackHours => update({ lookbackHours })}
          />
        </SettingsRow>

        <SettingsRow name="Active window" hint={'A session counts as "recent" if its last message is newer than this. Drives working vs idle.'}>
          <NumberField
            value={settings.activeWindowMin}
            min={LIMITS.activeWindowMin.min}
            max={LIMITS.activeWindowMin.max}
            unit="min"
            onCommit={activeWindowMin => update({ activeWindowMin })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Remote answers · every device">
        <SettingsRow
          name="Phone answers"
          hint={
            remote.state && !remote.state.available
              ? <>Disabled by <code>REMOTE_ANSWER=false</code> in the server config — a UI toggle can’t override the kill switch.</>
              : 'On, a question asked while you are away from the keyboard waits here instead of the terminal. At your desk it still goes straight to the terminal.'
          }
        >
          {remote.state && (
            <Segmented
              value={remote.state.available && remote.state.enabled ? 'on' : 'off'}
              options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
              onChange={v => {
                if (!remote.state?.available || remote.busy) return;
                if ((v === 'on') !== remote.state.enabled) void remote.toggle();
              }}
            />
          )}
        </SettingsRow>

        {server.state && (
          <>
            <SettingsRow
              name="Away after"
              hint="Keyboard and mouse idle before you count as away from the desk. Below it a question goes straight to the terminal dialog. 0 skips the check entirely."
            >
              <NumberField
                value={server.state.idleSecs}
                min={0}
                max={3600}
                unit="sec"
                onCommit={idleSecs => void server.save({ idleSecs })}
              />
              {server.saving && <span className="set-saving">saving…</span>}
            </SettingsRow>
            {server.state.idleOverride && (
              <div className="set-warn">
                <span>⚠</span>
                <span>
                  This is being overridden. <code>CLAUDE_DASHBOARD_IDLE_SECS={server.state.idleOverride.value}</code>{' '}
                  {server.state.idleOverride.source === 'settings.json'
                    ? <>is set in the <code>env</code> block of <code>~/.claude/settings.json</code>, and the hooks read that first.</>
                    : <>is exported in the shell, and the hooks read that first.</>}
                  {' '}Remove it for the value above to take effect. The dashboard won’t edit that file for you.
                </span>
              </div>
            )}
            {!server.state.persisted && (
              <div className="set-warn">
                <span>⚠</span>
                <span>Couldn’t be written to disk — this value holds until the server restarts.</span>
              </div>
            )}
            {server.needsToken && (
              <div className="set-warn">
                <span>⚠</span>
                <span>The server refused the request. Set the <code>ANSWER_TOKEN</code> below and try again.</span>
              </div>
            )}
          </>
        )}

        <SettingsRow
          name="Answer token"
          hint={<>Only needed when the server runs with <code>ANSWER_TOKEN</code> set. Stored on this device and sent with every write.</>}
        >
          <input
            type="text"
            value={token}
            placeholder="none"
            onChange={e => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Alerts · this device">
        <SettingsRow
          name="Tell me when a session needs me"
          hint={
            permission === 'unsupported'
              ? 'This browser has no notification API — the tab title will still show a count. On iPhone, add the dashboard to your home screen to get real notifications.'
              : permission === 'denied'
                ? 'Notifications are blocked for this site in your browser settings. The tab title will still show a count.'
                : 'Fires when a session starts waiting on you — a question, a plan, a permission dialog, or a finished turn. Never re-fires for one already waiting.'
          }
        >
          <Segmented
            value={settings.alertsEnabled ? 'on' : 'off'}
            options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
            onChange={v => void toggleAlerts(v === 'on')}
          />
        </SettingsRow>

        <SettingsRow name="Sound" hint="A two-tone chime alongside the notification.">
          <Segmented
            value={settings.alertsSound ? 'on' : 'off'}
            options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
            onChange={v => update({ alertsSound: v === 'on' })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Reset">
        <SettingsRow
          name="Reset this device"
          hint="Puts every setting above back to its default and clears saved filters, sort, the chat filter and the management pane state. Doesn’t touch the server or anything in ~/.claude."
        >
          {confirmReset ? (
            <>
              <button className="set-danger" onClick={() => { reset(); setConfirmReset(false); }}>
                Confirm reset
              </button>
              <button className="qp-term" onClick={() => setConfirmReset(false)}>Cancel</button>
            </>
          ) : (
            <button className="set-danger" onClick={() => setConfirmReset(true)}>Reset…</button>
          )}
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
