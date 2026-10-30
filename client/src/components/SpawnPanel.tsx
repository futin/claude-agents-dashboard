import { useEffect, useState } from 'react';

import MicButton from './MicButton';
import PinPicker from './PinPicker';
import { useBackClose } from '../hooks/useBackClose';
import { useConfigsIndex } from '../hooks/useConfigs';
import { usePins } from '../hooks/usePins';
import { useSettings } from '../hooks/useSettings';
import { useSpawn } from '../hooks/useSpawn';
import { appendTranscript } from '../lib/dictation';
import { DESKTOP_DEFAULTS_NOTE, DESKTOP_FAILED_TEXT, initialSurface, offeredSurfaces } from '../lib/launchSurface';
import {
  EFFORTS, MODELS, NAME_CAP, PERMISSION_MODE_LABEL, PERMISSION_MODES, PROMPT_CAP,
  allowedPermissionModes
} from '../lib/spawnOptions';
import type { LaunchSurface, PermissionMode, SpawnRequest, SpawnResponse } from '../../../shared/types';

interface Props {
  onClose: () => void;
  /**
   * A launch succeeded. A `dashboard` answer carries the new session's id, which the caller opens in the chat drawer; a `desktop` one carries none (the app
   * mints its own), so the caller says where it went instead. Either way the caller closes this panel.
   */
  onLaunched: (r: SpawnResponse) => void;
  /**
   * The host's permission-mode ceiling (`HealthResponse.spawnMaxPermission`),
   * lifted from the one `/api/health` poll `SessionsView` owns. Absent while
   * that poll hasn't answered yet, or on an older server — the picker then
   * falls back to offering up to `'auto'`, exactly as `allowedPermissionModes`
   * treats a real `'auto'` ceiling.
   */
  spawnMaxPermission?: PermissionMode;
  /**
   * `HealthResponse.spawnAvailable` / `desktopAvailable` off the same poll: which surfaces the form offers. The picker shows only when both are true, and
   * the form opens on one of them whatever a stale default says.
   */
  spawnAvailable?: boolean;
  desktopAvailable?: boolean;
  /** `HealthResponse.launchSurfaceDefault`. Only preselects the pick — the request carries `surface` solely when Desktop is chosen. */
  launchSurfaceDefault?: LaunchSurface;
}

/**
 * The launch form: pick a recent (or pinned) project, write (or dictate) a prompt, tap
 * launch.
 *
 * It is a **modal** (`.claude/DESIGN.md` §8.7, mock `#spawn`) rather than a
 * panel pinned into the Sessions column: a launch is a compose surface opened
 * on purpose, not a hold the board is answering, so it floats over the scrim
 * with air on every side and keeps the chat modal's exits — ✕, Escape, the
 * scrim, and the browser's back. All four are refused while a launch is in
 * flight, the same guard the cancel button has always carried.
 *
 * Inside it is one narrow column read top to bottom: project, prompt, name,
 * then model / effort / permission as a triplet, then remote control. Four
 * other shapes were drawn and dropped (a sidecar with the project list in its
 * own column, a composer with the flags as chips, a Settings-row ledger, a
 * launchpad of tiles); the sheet is the only one that fits a phone unchanged.
 * The chrome is cyan, not amber: amber means "a session is waiting on you".
 *
 * Project defaults to the most recently active one — `useConfigsIndex`'s
 * `projects` is already newest-first, so that's simply the first entry.
 *
 * A project past `LOOKBACK_HOURS` is not in that list, so under the select a
 * disclosure offers the older ones for pinning (#161, DESIGN.md §8.7): it
 * expands in place, inside the sheet, rather than opening a second surface. A
 * pin re-fetches the index and selects the project it just pinned.
 */
export default function SpawnPanel({ onClose, onLaunched, spawnMaxPermission, spawnAvailable, desktopAvailable, launchSurfaceDefault }: Props) {
  const { launch, pending, error, needsToken, setToken, clearError } = useSpawn();
  const [indexKey, setIndexKey] = useState(0);
  const { index, loading } = useConfigsIndex(indexKey);
  const { settings } = useSettings();
  const { pins, busy: pinBusy, setPin } = usePins();
  const [showOlder, setShowOlder] = useState(false);
  const projects = index?.projects ?? [];
  const older = pins?.older ?? [];

  // null = "the user hasn't touched this control yet" — once projects load,
  // the select falls back to the newest one without needing an effect to sync it.
  const [project, setProject] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  // Seeded from the per-device Settings defaults; '' still means "send no
  // --model/--effort flag and let the CLI decide".
  const [model, setModel] = useState<string>(settings.spawnDefaultModel);
  const [effort, setEffort] = useState<string>(settings.spawnDefaultEffort);
  // Same null-means-untouched pattern as `project` above: the derived default
  // below re-reacts if `spawnMaxPermission` arrives (or changes) after mount,
  // without an effect to keep them in sync.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  // Default ON: launches from this panel are phone-first, which is exactly when
  // account visibility (drive it from the phone app) is wanted. Uncheck for a
  // local-only run.
  const [remoteControl, setRemoteControl] = useState(true);
  // Default OFF: a free-typed prompt is the launch most likely to want a follow-up.
  const [oneShot, setOneShot] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  // null = untouched, like `project`: the health poll may still be answering when the form opens, so the preselect is derived on every render.
  const [picked, setPicked] = useState<LaunchSurface | null>(null);
  const offered = offeredSurfaces(spawnAvailable, desktopAvailable);
  const surface = picked && offered.includes(picked) ? picked : initialSurface(offered, launchSurfaceDefault);
  const desktop = surface === 'desktop';
  // Locked while a launch is in flight, and for every control a desktop launch ignores (the app applies its own).
  const lockDefaults = pending || desktop;

  const selectedProject = project ?? projects[0]?.dirName ?? '';

  // Only offer modes the server will actually honor — it clamps anything
  // above its ceiling silently, so showing them here would let a user pick
  // one thing and get another with no feedback. `allowedModes` always ends on
  // the (validated) ceiling itself, so falling back to its last element when
  // 'auto' isn't in range (a 'plan' ceiling) still clamps toward the ceiling
  // rather than toward the top of the ladder.
  const allowedModes = allowedPermissionModes(spawnMaxPermission);
  const defaultMode = allowedModes.includes('auto') ? 'auto' : allowedModes[allowedModes.length - 1];
  const selectedMode = permissionMode && allowedModes.includes(permissionMode) ? permissionMode : defaultMode;
  const ceilingLimited = allowedModes.length < PERMISSION_MODES.length;
  const ceilingLabel = PERMISSION_MODE_LABEL[allowedModes[allowedModes.length - 1]];
  const permissionTitle = ceilingLimited
    ? `This host limits launches to '${ceilingLabel}' or below (SPAWN_MAX_PERMISSION).`
    : undefined;

  const canLaunch = !pending && surface !== null && prompt.trim() !== '' && selectedProject !== '';

  // Every exit is the cancel button's exit: refused mid-launch, so a stray tap
  // on the scrim can't unmount the request's own `pending` guard.
  function close(): void {
    if (!pending) onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  // Same intent as Escape, for the input a phone actually has: below `md`
  // (768px) the modal is full-screen and there is no scrim left to tap.
  useBackClose(close);

  async function pinAndSelect(dirName: string): Promise<string | null> {
    const failure = await setPin(dirName, true);
    if (failure) return failure;
    setIndexKey(k => k + 1);
    setProject(dirName);
    setShowOlder(false);
    return null;
  }

  async function doLaunch(): Promise<void> {
    if (!canLaunch) return;
    const req: SpawnRequest = {
      project: selectedProject, prompt: prompt.trim(), permissionMode: selectedMode, remoteControl
    };
    if (desktop) {
      req.surface = 'desktop';
    } else {
      if (name.trim()) req.name = name.trim();
      if (model) req.model = model;
      if (effort) req.effort = effort;
      if (oneShot) req.oneShot = true;
    }
    const result = await launch(req);
    if (result) onLaunched(result);
  }

  return (
    <div className="spawn-back" onClick={close}>
      <div className="spawn" role="dialog" aria-label="New session" onClick={e => e.stopPropagation()}>
        <div className="spawn-head">
          <span className="qp-badge">new session</span>
          <span className="qp-hint">
            {desktop ? 'opens in the desktop app on this Mac' : 'spawns a headless session in the picked project'}
          </span>
          <span className="spacer" />
          <button type="button" className="chat-x" onClick={close} disabled={pending} aria-label="Close">✕</button>
        </div>

        <div className="spawn-body">
          {offered.length > 1 && (
            <div className="sp-field">
              <span className="sp-label">open in</span>
              <span className="set-seg sp-surface" role="group" aria-label="Open in">
                <button type="button" className={desktop ? '' : 'on'} aria-pressed={!desktop} disabled={pending} onClick={() => { setPicked('dashboard'); clearError(); }}>
                  Dashboard
                </button>
                <button type="button" className={desktop ? 'on' : ''} aria-pressed={desktop} disabled={pending} onClick={() => setPicked('desktop')}>
                  Desktop
                </button>
              </span>
            </div>
          )}

          <label className="sp-field">
            <span className="sp-label">project</span>
            <span className="sp-select">
              <select
                value={selectedProject}
                disabled={pending}
                onChange={e => setProject(e.target.value)}
              >
                {projects.length === 0 && (
                  <option value="">{loading ? 'loading projects…' : 'no recent projects'}</option>
                )}
                {projects.map(p => (
                  <option key={p.dirName} value={p.dirName}>{p.name}</option>
                ))}
              </select>
            </span>
          </label>

          {(older.length > 0 || showOlder) && (
            <div className="sp-older">
              <button
                type="button"
                className="sp-more"
                aria-expanded={showOlder}
                disabled={pending}
                onClick={() => setShowOlder(v => !v)}
              >
                {showOlder ? 'Hide older projects' : `Not listed? Show older projects · ${older.length}`}
              </button>
              {showOlder && pins && (
                <>
                  <PinPicker projects={older} home={pins.home} busy={pinBusy} onPin={pinAndSelect} />
                  <span className="sp-note">
                    A pin keeps a project listed past the lookback, on every device. Unpin it under Management › Projects.
                  </span>
                </>
              )}
            </div>
          )}

          <label className="sp-field">
            <span className="sp-label">prompt</span>
            <textarea
              className="qp-feedback"
              maxLength={PROMPT_CAP}
              rows={6}
              placeholder="What should this session do?"
              value={prompt}
              disabled={pending}
              onChange={e => setPrompt(e.target.value)}
            />
            <span className="sp-count">{prompt.length} / {PROMPT_CAP}</span>
          </label>

          {/* the name owns a line; the three flags share the next one */}
          <label className="sp-field">
            <span className="sp-label">name</span>
            <input
              className="qp-other"
              type="text"
              maxLength={NAME_CAP}
              placeholder="optional"
              value={name}
              disabled={lockDefaults}
              onChange={e => setName(e.target.value)}
            />
          </label>

          <div className="sp-row">
            <label className="sp-field">
              <span className="sp-label">model</span>
              <span className="sp-select">
                <select value={model} disabled={lockDefaults} onChange={e => setModel(e.target.value)}>
                  <option value="">default</option>
                  {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </span>
            </label>
            <label className="sp-field">
              <span className="sp-label">effort</span>
              <span className="sp-select">
                <select value={effort} disabled={lockDefaults} onChange={e => setEffort(e.target.value)}>
                  <option value="">default</option>
                  {EFFORTS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </span>
            </label>
            <label className="sp-field">
              <span className="sp-label">permission</span>
              <span className="sp-select">
                <select
                  value={selectedMode}
                  disabled={lockDefaults}
                  title={permissionTitle}
                  onChange={e => setPermissionMode(e.target.value as PermissionMode)}
                >
                  {allowedModes.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABEL[m]}</option>)}
                </select>
              </span>
            </label>
          </div>

          {/* the ceiling clamps a headless launch; the desktop app applies its own permission mode */}
          {ceilingLimited && !desktop && (
            <span className="sp-note">
              host ceiling · {ceilingLabel} or below (SPAWN_MAX_PERMISSION)
            </span>
          )}

          {/* the board's boolean is the pill switch, the same one Settings draws */}
          <div className="sp-toggle">
            <span className="sp-toggle-text">
              <span className="sp-toggle-name">Remote control</span>
              <span className="sp-toggle-hint">
                Register the session with your account so the Claude phone app can see and
                drive it. It still runs on this machine.
              </span>
            </span>
            <span className="set-seg" role="group" aria-label="Remote control">
              <button
                type="button"
                className={remoteControl ? '' : 'on'}
                aria-pressed={!remoteControl}
                disabled={lockDefaults}
                onClick={() => setRemoteControl(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={remoteControl ? 'on' : ''}
                aria-pressed={remoteControl}
                disabled={lockDefaults}
                onClick={() => setRemoteControl(true)}
              >
                On
              </button>
            </span>
          </div>

          <div className="sp-toggle">
            <span className="sp-toggle-text">
              <span className="sp-toggle-name">Close when done</span>
              <span className="sp-toggle-hint">
                End the session when its work is done instead of waiting for a reply. Follow up with Resume.
              </span>
            </span>
            <span className="set-seg" role="group" aria-label="Close when done">
              <button
                type="button"
                className={oneShot ? '' : 'on'}
                aria-pressed={!oneShot}
                disabled={lockDefaults}
                onClick={() => setOneShot(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={oneShot ? 'on' : ''}
                aria-pressed={oneShot}
                disabled={lockDefaults}
                onClick={() => setOneShot(true)}
              >
                On
              </button>
            </span>
          </div>

          {desktop && <span className="sp-note">{DESKTOP_DEFAULTS_NOTE}</span>}

          {needsToken && (
            <div className="qp-token">
              <span className="qp-note">This dashboard needs its answer token.</span>
              <input
                className="qp-other"
                type="password"
                placeholder="ANSWER_TOKEN"
                value={tokenDraft}
                onChange={e => setTokenDraft(e.target.value)}
              />
              <button type="button" className="qp-send" onClick={() => setToken(tokenDraft.trim())}>
                Save
              </button>
            </div>
          )}

          {/* The server's `open failed` is a fixed body with nothing to act on; the line names what happened (spec decision 12). */}
          {error && <span className="qp-note sp-error">{desktop && error === 'open failed' ? DESKTOP_FAILED_TEXT : error}</span>}
        </div>

        <div className="spawn-foot">
          <MicButton disabled={pending} onText={t => setPrompt(cur => appendTranscript(cur, t))} />
          <span className="spacer" />
          <button type="button" className="qp-term" disabled={pending} onClick={close}>
            Cancel
          </button>
          <button type="button" className="qp-send" disabled={!canLaunch} onClick={() => void doLaunch()}>
            {pending ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </div>
    </div>
  );
}
