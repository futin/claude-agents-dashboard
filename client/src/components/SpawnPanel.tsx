import { useState } from 'react';

import MicButton from './MicButton';
import { useManagementIndex } from '../hooks/useManagement';
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
 * launch. Pinned like `MessagePanel`/`QuestionPanel` — same `.qpanel` chrome,
 * cyan instead of amber (amber means "a session is waiting on you"; this
 * panel is the opposite of a hold, a compose surface opened on purpose).
 *
 * Project defaults to the most recently active one — `useManagementIndex`'s
 * `projects` is already newest-first, so that's simply the first entry.
 */
export default function SpawnPanel({ onClose, onLaunched, spawnMaxPermission }: Props) {
  const { launch, pending, error, needsToken, setToken } = useSpawn();
  const { index, loading } = useManagementIndex(0);
  const projects = index?.projects ?? [];

  // null = "the user hasn't touched this control yet" — once projects load,
  // the select falls back to the newest one without needing an effect to sync it.
  const [project, setProject] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  // Same null-means-untouched pattern as `project` above: the derived default
  // below re-reacts if `spawnMaxPermission` arrives (or changes) after mount,
  // without an effect to keep them in sync.
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
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
  const permissionTitle = ceilingLimited
    ? `This host limits launches to '${PERMISSION_MODE_LABEL[allowedModes[allowedModes.length - 1]]}' or below (SPAWN_MAX_PERMISSION).`
    : undefined;

  const canLaunch = !pending && prompt.trim() !== '' && selectedProject !== '';

  async function doLaunch(): Promise<void> {
    if (!canLaunch) return;
    const req: SpawnRequest = { project: selectedProject, prompt: prompt.trim(), permissionMode: selectedMode };
    if (name.trim()) req.name = name.trim();
    if (model) req.model = model;
    if (effort) req.effort = effort;
    const sessionId = await launch(req);
    if (sessionId) onLaunched(sessionId);
  }

  return (
    <div className="qpanel spawn">
      <div className="qp-head">
        <span className="qp-badge">new session</span>
        <span className="qp-hint">spawns a headless session in the picked project</span>
        <button type="button" className="chat-x sp-x" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <label className="sp-field">
        <span className="sp-label">project</span>
        <select
          className="qp-select"
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
      </label>

      <textarea
        className="qp-feedback"
        maxLength={PROMPT_CAP}
        rows={4}
        placeholder="What should this session do?"
        value={prompt}
        disabled={pending}
        onChange={e => setPrompt(e.target.value)}
      />

      <div className="sp-row">
        <label className="sp-field">
          <span className="sp-label">name</span>
          <input
            className="qp-other sp-name"
            type="text"
            maxLength={NAME_CAP}
            placeholder="optional"
            value={name}
            disabled={pending}
            onChange={e => setName(e.target.value)}
          />
        </label>
        <label className="sp-field">
          <span className="sp-label">model</span>
          <select className="qp-select" value={model} disabled={pending} onChange={e => setModel(e.target.value)}>
            <option value="">default</option>
            {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="sp-field">
          <span className="sp-label">effort</span>
          <select className="qp-select" value={effort} disabled={pending} onChange={e => setEffort(e.target.value)}>
            <option value="">default</option>
            {EFFORTS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="sp-field">
          <span className="sp-label">permission</span>
          <select
            className="qp-select"
            value={selectedMode}
            disabled={pending}
            title={permissionTitle}
            onChange={e => setPermissionMode(e.target.value as PermissionMode)}
          >
            {allowedModes.map(m => <option key={m} value={m}>{PERMISSION_MODE_LABEL[m]}</option>)}
          </select>
        </label>
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

      <div className="qp-actions">
        <MicButton disabled={pending} onText={t => setPrompt(cur => appendTranscript(cur, t))} />
        <button type="button" className="qp-send" disabled={!canLaunch} onClick={() => void doLaunch()}>
          {pending ? 'launching…' : 'launch'}
        </button>
        <button type="button" className="qp-term" disabled={pending} onClick={onClose}>
          cancel
        </button>
      </div>
    </div>
  );
}
