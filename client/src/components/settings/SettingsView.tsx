import { useState } from 'react';

import { NumberField, Segmented, SettingsGroup, SettingsRow } from './SettingsRow';
import { usePersistedState } from '../../hooks/usePersistedState';
import { useRemoteAnswer } from '../../hooks/useRemoteAnswer';
import { useServerSettings } from '../../hooks/useServerSettings';
import { useSettings } from '../../hooks/useSettings';
import {
  fireTestNotification, requestWebNotifyPermission, unlockAudio,
  webNotifyPermission, webNotifySupported
} from '../../hooks/useWebNotify';
import {
  FONT_SCALES, LIMITS, REFRESH_CHOICES, THEMES,
  formatInterval, type Landing, type SpawnDefaultEffort, type SpawnDefaultModel, type ThemeId
} from '../../lib/settings';
import { EFFORTS, MODELS } from '../../lib/spawnOptions';

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

/** The four push events, ordered by how much they matter when you are away. */
const NOTIFY_EVENT_ROWS = [
  { key: 'question' as const, name: 'Question waiting', hint: 'A session is asking something you can answer from the dashboard.' },
  { key: 'permission' as const, name: 'Permission dialog open', hint: 'A terminal permission dialog is blocking a session until you return.' },
  { key: 'plan' as const, name: 'Plan waiting for review', hint: 'A proposed plan is held for a remote send-back.' },
  { key: 'stop' as const, name: 'Task finished', hint: 'A session finished its turn. Suppressed while background agents are still running.' }
];

const ON_OFF = [{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }];

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
  const [confirmReset, setConfirmReset] = useState(false);
  const [pushTestResult, setPushTestResult] = useState<string | null>(null);
  const [webTestResult, setWebTestResult] = useState<string | null>(null);
  const [webPermission, setWebPermission] = useState(() => webNotifyPermission());
  const notify = server.state?.notify;
  /**
   * No `NTFY_TOPIC` on the server, so every switch below would flip, persist and
   * send nothing. Gated rather than hidden: the rows are how you find out the
   * feature exists. Stays false while the settings are still loading — an
   * unanswered fetch is not evidence of a missing topic.
   */
  const pushUnconfigured = !!server.state && !server.state.notifyAvailable;

  /**
   * Turning "Only when I'm away" off does **not** make `question` and `plan`
   * unconditional, and nothing else on this page would tell you that.
   *
   * Both are published from the endpoint the remote-answer hook POSTs to, and the
   * hook applies its own idle check *before* that POST (`ask-remote.sh`,
   * `plan-remote.sh`). At the desk it exits and lets the terminal dialog take the
   * question, so the server never learns there is anything to push about and the
   * policy below is never consulted. `permission` and `stop` have no such gate in
   * their hooks, so those two really do become unconditional.
   *
   * Shown only in the state where that surprises you: pushes on, the switch off,
   * the threshold live, and at least one of the two affected events on.
   */
  const afkStillGatesRemote =
    !pushUnconfigured &&
    !!notify?.enabled &&
    !notify.requireAfk &&
    (notify.events.question || notify.events.plan) &&
    (server.state?.idleSecs ?? 0) > 0;

  /**
   * Both the permission prompt and resuming the AudioContext are gesture-gated,
   * so they have to ride the click that flipped the switch — `unlockAudio` first
   * and un-awaited, because awaiting it would spend the activation before the
   * prompt asks for it. The setting is stored on either way: a denied permission
   * still leaves the beep, and the warning below says so rather than letting the
   * switch read On while being silently impossible.
   */
  async function toggleWebNotify(on: boolean): Promise<void> {
    update({ notifyBrowser: on });
    if (!on) return;
    void unlockAudio();
    setWebPermission(await requestWebNotifyPermission());
  }

  async function sendTestNotification(): Promise<void> {
    setWebTestResult('sending…');
    setWebTestResult(await fireTestNotification());
    setWebPermission(webNotifyPermission());
  }

  /**
   * An off switch, a missing topic and a dropped packet all look identical from
   * here, so the server reports what it actually did rather than the button
   * pretending. The one honest answer to "is this working?" is to fire one.
   */
  async function sendTestPush(): Promise<void> {
    setPushTestResult('sending…');
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/notify/test', { method: 'POST', headers });
      const body = (await res.json()) as { outcome?: string; error?: string };
      setPushTestResult(body.outcome ?? body.error ?? 'no response');
    } catch {
      setPushTestResult('the dashboard did not answer');
    }
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

        <SettingsRow
          name="Chat messages"
          hint="Truncated cuts a message at 2 000 characters and a tool body at 20 000 — enough to see what a session is doing. Full sends the whole thing (a page still reads at most one 512 KB window). Changing this re-tails an open drawer."
        >
          <Segmented
            value={settings.chatFullText ? 'full' : 'cut'}
            options={[{ value: 'cut' as const, label: 'Truncated' }, { value: 'full' as const, label: 'Full' }]}
            onChange={v => update({ chatFullText: v === 'full' })}
          />
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

      <SettingsGroup title="New sessions · this device">
        <SettingsRow
          name="Default model"
          hint="Preselected in the launch panel's model picker. “CLI default” sends no --model flag, letting Claude Code pick. You can still override it per launch."
        >
          <select
            value={settings.spawnDefaultModel}
            onChange={e => update({ spawnDefaultModel: e.target.value as SpawnDefaultModel })}
          >
            <option value="">CLI default</option>
            {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </SettingsRow>

        <SettingsRow
          name="Default effort"
          hint="Preselected in the launch panel's effort picker. “CLI default” sends no --effort flag."
        >
          <select
            value={settings.spawnDefaultEffort}
            onChange={e => update({ spawnDefaultEffort: e.target.value as SpawnDefaultEffort })}
          >
            <option value="">CLI default</option>
            {EFFORTS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Usage forecast · every device">
        <SettingsRow
          name="Record usage history"
          hint="Samples your account usage to disk so the weekly forecast can learn which hours you actually work. While on, the server contacts Anthropic about once a minute even with no browser open. Needs ~2 weeks of data before the forecast improves."
        >
          <Segmented
            value={server.state?.recordUsageHistory ? 'on' : 'off'}
            options={ON_OFF}
            onChange={v => void server.save({ recordUsageHistory: v === 'on' })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Remote answers · every device">
        <SettingsRow
          name="Remote answers"
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
              hint="Keyboard and mouse idle before you count as away from the desk. Below it a question goes straight to the terminal dialog — and no question or plan push is sent, whatever the push switches say. 0 skips the check entirely."
            >
              <NumberField
                value={server.state.idleSecs}
                min={0}
                max={3600}
                unit="sec"
                onCommit={idleSecs => void server.save({ idleSecs })}
              />
              {server.isSaving('idleSecs') && <span className="set-saving">saving…</span>}
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
            <SettingsRow
              name="Answer window"
              hint="How long a question or plan stays answerable here before it gives up and the terminal dialog appears instead. Applies from the moment it is asked."
            >
              <NumberField
                value={server.state.answerSecs}
                min={5}
                max={600}
                unit="sec"
                onCommit={answerSecs => void server.save({ answerSecs })}
              />
              {server.isSaving('answerSecs') && <span className="set-saving">saving…</span>}
            </SettingsRow>
            {server.state.answerOverride && (
              <div className="set-warn">
                <span>⚠</span>
                <span>
                  This is being overridden. <code>CLAUDE_DASHBOARD_ANSWER_TIMEOUT={server.state.answerOverride.value}</code>{' '}
                  {server.state.answerOverride.source === 'settings.json'
                    ? <>is set in the <code>env</code> block of <code>~/.claude/settings.json</code>, and the hooks read that first.</>
                    : <>is exported in the shell, and the hooks read that first.</>}
                  {' '}Remove it for the value above to take effect. The dashboard won’t edit that file for you.
                </span>
              </div>
            )}
            {server.state.answerSecs > 600 && (
              <div className="set-warn">
                <span>⚠</span>
                <span>
                  Above 600s the CLI kills the hook before the window closes, unless you also raise{' '}
                  <code>timeout</code> on the hook entry in <code>~/.claude/settings.json</code> to at least{' '}
                  <code>{server.state.answerSecs + 15}</code>. Until then it falls back to the terminal dialog early.
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

      {/* This device only, and narrow on purpose: a session spawned from the
          dashboard has no terminal in front of it, so it is the one class with
          no desk-side channel at all. Absent entirely where `Notification` does
          not exist (iOS in a tab) — a switch that reads On while nothing can
          fire was the bug that got the old alerts layer deleted. */}
      {webNotifySupported() && (
        <SettingsGroup title="Notify this browser · this device">
          <SettingsRow
            name="Notify this browser"
            hint="An OS banner and one beep when a session launched from here — the ones carrying the dashboard pill — has a question, a plan waiting for review, or an open reply window. Nothing else announces those: there is no terminal in front of them. Only fires while this tab is open on Sessions."
          >
            <Segmented
              value={settings.notifyBrowser ? 'on' : 'off'}
              options={ON_OFF}
              onChange={v => void toggleWebNotify(v === 'on')}
            />
          </SettingsRow>

          {settings.notifyBrowser && webPermission === 'denied' && (
            <div className="set-warn">
              <span>⚠</span>
              <span>
                Notifications are blocked for this site in your browser settings, so only the
                beep will fire. Allow them for this site to get the banner back — the browser
                won’t ask again while it is blocked.
              </span>
            </div>
          )}

          <SettingsRow
            name="Test notification"
            hint={
              webTestResult ??
              'Fires one banner and one beep right now, ignoring the switch above, and says what the browser did with each.'
            }
          >
            <button onClick={() => void sendTestNotification()}>Send test notification</button>
          </SettingsRow>
        </SettingsGroup>
      )}

      {/* Server-backed, hence "every device": the policy lives on the server and
          the server sends, so nothing here depends on a tab being open. This is
          the app's only way of telling you something needs you when you are not
          looking at the dashboard. */}
      <SettingsGroup title="Push notifications · every device">
        <SettingsRow
          name="Send push notifications"
          hint={
            pushUnconfigured
              ? 'Unavailable until ntfy is configured on the server.'
              : 'Pushes to your phone through ntfy, so alerts arrive with the browser closed. Tapping one opens that session’s chat.'
          }
        >
          <Segmented
            value={notify?.enabled ? 'on' : 'off'}
            options={ON_OFF}
            disabled={pushUnconfigured}
            onChange={v => void server.saveNotify({ enabled: v === 'on' })}
          />
        </SettingsRow>

        {/* The one thing the server can check for free: whether a topic is set at
            all. Whether a phone is actually subscribed to it is unknowable from
            here — that is what the test push at the bottom is for. */}
        {pushUnconfigured && (
          <div className="set-warn">
            <span>⚠</span>
            <span>
              No ntfy topic on the server, so nothing below can send. Set{' '}
              <code>NTFY_TOPIC</code> in <code>.env</code> and restart it. Treat the topic as a
              secret — it is both the address and the credential, so anyone who learns it can
              read your notifications and publish to your phone. Set{' '}
              <code>DASHBOARD_PUBLIC_URL</code> too, or tapping a push won’t open this dashboard.
            </span>
          </div>
        )}

        {NOTIFY_EVENT_ROWS.map(row => (
          <SettingsRow key={row.key} name={row.name} hint={row.hint}>
            <Segmented
              value={notify?.events[row.key] ? 'on' : 'off'}
              options={ON_OFF}
              disabled={pushUnconfigured}
              onChange={v => void server.saveNotify({ events: { [row.key]: v === 'on' } })}
            />
          </SettingsRow>
        ))}

        <SettingsRow
          name="Only while accepting remote answers"
          hint="Ties pushes to the Remote answers switch above, so one toggle covers both."
        >
          <Segmented
            value={notify?.requireRemoteAnswer ? 'on' : 'off'}
            options={ON_OFF}
            disabled={pushUnconfigured}
            onChange={v => void server.saveNotify({ requireRemoteAnswer: v === 'on' })}
          />
        </SettingsRow>

        <SettingsRow
          name="Only when I'm away"
          hint={`No push until you've been away from the keyboard for ${server.state?.idleSecs ?? 60}s — the same threshold the remote-answer hooks use.`}
        >
          <Segmented
            value={notify?.requireAfk ? 'on' : 'off'}
            options={ON_OFF}
            disabled={pushUnconfigured}
            onChange={v => void server.saveNotify({ requireAfk: v === 'on' })}
          />
        </SettingsRow>

        {afkStillGatesRemote && (
          <div className="set-warn">
            <span>⚠</span>
            <span>
              Off here, but <b>Question waiting</b> and <b>Plan waiting for review</b> still only
              push once you are away. Those two are sent when the remote-answer hook hands the
              question to the dashboard, and that hook stops at the desk on its own: under{' '}
              <b>{server.state?.idleSecs ?? 60}s</b> of idle it gives the question to the terminal
              dialog instead, so there is nothing here to push about. Set <b>Away after</b> to 0 to
              drop that gate too. <b>Permission dialog open</b> and <b>Task finished</b> have no
              such gate and push whenever they fire.
            </span>
          </div>
        )}

        <SettingsRow
          name="Only in auto permission modes"
          hint="Limits pushes to sessions running as auto, bypassPermissions or dontAsk. Older CLIs don't report the mode, so permission-dialog pushes stop too."
        >
          <Segmented
            value={notify?.requireAutoMode ? 'on' : 'off'}
            options={ON_OFF}
            disabled={pushUnconfigured}
            onChange={v => void server.saveNotify({ requireAutoMode: v === 'on' })}
          />
        </SettingsRow>

        <SettingsRow
          name="Test push"
          hint={
            pushTestResult ??
            (pushUnconfigured
              ? 'Nothing to send to until NTFY_TOPIC is set.'
              : 'Sends one push right now, ignoring every switch above, and waits for ntfy’s answer before saying what happened. Only your phone can confirm the last step.')
          }
        >
          <button disabled={pushUnconfigured} onClick={() => void sendTestPush()}>Send test push</button>
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
