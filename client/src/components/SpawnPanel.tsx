import { useEffect, useState } from 'react';

import MicButton from './MicButton';
import { useBackClose } from '../hooks/useBackClose';
import { useManagementIndex } from '../hooks/useManagement';
import { useSettings } from '../hooks/useSettings';
import { useSpawn } from '../hooks/useSpawn';
import { appendTranscript } from '../lib/dictation';
import {
  EFFORTS, MODELS, NAME_CAP, PERMISSION_MODE_LABEL, PERMISSION_MODES, PROMPT_CAP,
  allowedPermissionModes
} from '../lib/spawnOptions';
import type { PermissionMode, SpawnRequest } from '../../../shared/types';

interface Props {
  onClose: () => void;
  /** A launch succeeded — the caller opens the chat drawer for it (and closes this panel). */
  onLaunched: (sessionId: string) => void;
  /**
   * The host's permission-mode ceiling (`HealthResponse.spawnMaxPermission`),
   * lifted from the one `/api/health` poll `SessionsView` owns. Absent while
   * that poll hasn't answered yet, or on an older server — the picker then
   * falls back to offering up to `'auto'`, exactly as `allowedPermissionModes`
   * treats a real `'auto'` ceiling.
   */
  spawnMaxPermission?: PermissionMode;
}

/**
 * The launch form: pick a recent project, write (or dictate) a prompt, tap
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
 * Project defaults to the most recently active one — `useManagementIndex`'s
 * `projects` is already newest-first, so that's simply the first entry.
 */
export default function SpawnPanel({ onClose, onLaunched, spawnMaxPermission }: Props) {
  const { launch, pending, error, needsToken, setToken } = useSpawn();
  const { index, loading } = useManagementIndex(0);
  const { settings } = useSettings();
  const projects = index?.projects ?? [];

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
  const [tokenDraft, setTokenDraft] = useState('');

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

  const canLaunch = !pending && prompt.trim() !== '' && selectedProject !== '';

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

  // Same intent as Escape, for the input a phone actually has: at <=700px the
  // modal is full-screen and there is no scrim left to tap.
  useBackClose(close);

  async function doLaunch(): Promise<void> {
    if (!canLaunch) return;
    const req: SpawnRequest = {
      project: selectedProject, prompt: prompt.trim(), permissionMode: selectedMode, remoteControl
    };
    if (name.trim()) req.name = name.trim();
    if (model) req.model = model;
    if (effort) req.effort = effort;
    const sessionId = await launch(req);
    if (sessionId) onLaunched(sessionId);
  }

  return (
    <div className="spawn-back" onClick={close}>
      <div className="spawn" role="dialog" aria-label="New session" onClick={e => e.stopPropagation()}>
        <div className="spawn-head">
          <span className="qp-badge">new session</span>
          <span className="qp-hint">spawns a headless session in the picked project</span>
          <span className="spacer" />
          <button type="button" className="chat-x" onClick={close} disabled={pending} aria-label="Close">✕</button>
        </div>

        <div className="spawn-body">
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
              disabled={pending}
              onChange={e => setName(e.target.value)}
            />
          </label>

          <div className="sp-row">
            <label className="sp-field">
              <span className="sp-label">model</span>
              <span className="sp-select">
                <select value={model} disabled={pending} onChange={e => setModel(e.target.value)}>
                  <option value="">default</option>
                  {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </span>
            </label>
            <label className="sp-field">
              <span className="sp-label">effort</span>
              <span className="sp-select">
                <select value={effort} disabled={pending} onChange={e => setEffort(e.target.value)}>
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
                  disabled={pending}
                  title={permissionTitle}
                  onChange={e => setPermissionMode(e.target.value as PermissionMode)}
                >
                  {allowedModes.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABEL[m]}</option>)}
                </select>
              </span>
            </label>
          </div>

          {ceilingLimited && (
            <span className="sp-note">
              host ceiling · {ceilingLabel} or below (SPAWN_MAX_PERMISSION)
            </span>
          )}

          {/* the board's boolean is the pill switch, the same one Settings draws */}
          <div className="sp-toggle">
            <span className="sp-toggle-text">
              <span className="sp-toggle-name">remote control</span>
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
                disabled={pending}
                onClick={() => setRemoteControl(false)}
              >
                Off
              </button>
              <button
                type="button"
                className={remoteControl ? 'on' : ''}
                aria-pressed={remoteControl}
                disabled={pending}
                onClick={() => setRemoteControl(true)}
              >
                On
              </button>
            </span>
          </div>

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
                save
              </button>
            </div>
          )}

          {error && <span className="qp-note sp-error">{error}</span>}
        </div>

        <div className="spawn-foot">
          <MicButton disabled={pending} onText={t => setPrompt(cur => appendTranscript(cur, t))} />
          <span className="spacer" />
          <button type="button" className="qp-term" disabled={pending} onClick={close}>
            cancel
          </button>
          <button type="button" className="qp-send" disabled={!canLaunch} onClick={() => void doLaunch()}>
            {pending ? 'launching…' : 'launch'}
          </button>
        </div>
      </div>
    </div>
  );
}
