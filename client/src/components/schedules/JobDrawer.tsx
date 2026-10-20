import { useEffect, useRef, useState } from 'react';

import { serializeEnabled, type JobError } from '../../../../shared/schedule-file';
import type { ScheduleFile, ScheduleJobRow, ScheduleValidateResponse } from '../../../../shared/types';
import { useAnswerToken } from '../../hooks/useAnswerToken';
import { useBackClose } from '../../hooks/useBackClose';
import type { ScheduleWriteControl } from '../../hooks/useScheduleWrite';
import { authHeaders } from '../../lib/answerToken';
import {
  editsWithoutAsking, jobPins, jobTemplate, launchdLabel, nameProblem, readForeach, setRepos, type ForeachMode, type JobKind
} from '../../lib/schedules';
import type { ScheduleCtl } from './ctl';

const VALIDATE_MS = 300;

const KINDS: Array<{ kind: JobKind; title: string; line: string; small: string }> = [
  { kind: 'shell', title: 'Shell script', line: 'Runs a bash block. No tokens, no transcript.', small: 'exit code + last lines logged' },
  { kind: 'prompt', title: 'Claude prompt', line: 'Runs claude -p with the body as the prompt.', small: 'session + cost logged' },
  { kind: 'skill', title: 'Claude skill', line: 'Same, the body is one /skill line.', small: 'git-sync, docs-sync, kaizen…' }
];

/**
 * New job and Edit job (spec §UI, screens 4–5): one drawer, the file is the form. The kind picker only fills a template; the Repos helper reads the
 * `foreach:` line on every change and rewrites only that line (and `cwd:`) when used. The text is checked against `/validate` as it is typed. An edit
 * whose file changed on disk since it was loaded (the row's `mtimeMs` moved) cannot be saved until it is reloaded, so a save never overwrites an edit
 * made elsewhere. A non-owner sees the file read-only.
 */
export default function JobDrawer({ mode, row, confirmDelete, existing, ctl, send, onClose }: {
  mode: 'new' | 'edit';
  row: ScheduleJobRow | null;
  confirmDelete: boolean;
  existing: string[];
  ctl: ScheduleCtl;
  send: ScheduleWriteControl['send'];
  onClose(): void;
}) {
  const [token] = useAnswerToken();
  const [kind, setKind] = useState<JobKind>('shell');
  const [name, setName] = useState(mode === 'edit' && row ? row.name : '');
  const [text, setText] = useState(mode === 'new' ? jobTemplate('shell') : '');
  const [loaded, setLoaded] = useState<{ text: string; mtimeMs: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [check, setCheck] = useState<ScheduleValidateResponse | null>(null);
  const [serverErrors, setServerErrors] = useState<JobError[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(confirmDelete);
  const seq = useRef(0);
  const readOnly = !ctl.owner;
  const fileName = mode === 'edit' && row ? row.name : name;

  useBackClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const load = () => {
    if (!row) return;
    setLoadFailed(false);
    fetch(`/api/schedules/${encodeURIComponent(row.name)}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<ScheduleFile>; })
      .then(file => { setText(file.text); setLoaded({ text: file.text, mtimeMs: file.mtimeMs }); setServerErrors(null); setFailure(null); })
      .catch(() => setLoadFailed(true));
  };
  useEffect(() => { if (mode === 'edit') load(); }, []);

  // Validate as typed; the seq drops an answer that a later keystroke already superseded.
  useEffect(() => {
    if (mode === 'edit' && loaded === null) return;
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      fetch('/api/schedules/validate', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(fileName ? { text, name: fileName } : { text })
      })
        .then(res => (res.ok ? res.json() as Promise<ScheduleValidateResponse> : null))
        .then(body => { if (mine === seq.current && body && Array.isArray(body.errors)) setCheck(body); })
        .catch(() => { /* the server's own check on Save still answers */ });
    }, VALIDATE_MS);
    return () => window.clearTimeout(timer);
  }, [text, fileName, loaded === null]);

  const pinNames = jobPins('pinned', ctl.pins);
  const repos = readForeach(text);
  const picks = [...repos.picks, ...pinNames.filter(n => !repos.picks.includes(n))];
  const setMode = (m: ForeachMode) => {
    if (m === repos.mode) return;
    // Pick starts from every pin, so switching from All pinned is a no-op in what runs until a chip is turned off.
    setText(setRepos(text, m, m === 'pick' ? (repos.picks.length > 0 ? repos.picks : pinNames) : []));
  };
  const flipPick = (n: string) => setText(setRepos(text, 'pick', repos.picks.includes(n) ? repos.picks.filter(x => x !== n) : [...repos.picks, n]));

  const nameErr = mode === 'new' ? nameProblem(name, existing) : null;
  const errors = serverErrors ?? check?.errors ?? [];
  const diskChanged = mode === 'edit' && row !== null && loaded !== null && row.mtimeMs !== loaded.mtimeMs;
  const dirty = mode === 'new' || (loaded !== null && text !== loaded.text);
  const canSave = !readOnly && !ctl.locked && !saving && !diskChanged && nameErr === null && errors.length === 0 && (mode === 'new' || (loaded !== null && dirty));

  const save = async (enabled: boolean | null) => {
    setSaving(true);
    setFailure(null);
    const r = mode === 'new'
      ? await send('Save', `save:${name}`, 'POST', '/api/schedules', { name, text: serializeEnabled(text, enabled ?? true) }, true)
      : await send('Save', `save:${row!.name}`, 'PUT', `/api/schedules/${encodeURIComponent(row!.name)}`, { text }, true);
    setSaving(false);
    if (r.ok) { onClose(); return; }
    const body = r.body as { errors?: JobError[] } | null;
    if (r.status === 422 && body && Array.isArray(body.errors)) setServerErrors(body.errors);
    setFailure(r.failure);
  };

  const remove = async () => {
    setSaving(true);
    const r = await send('Delete', `delete:${row!.name}`, 'DELETE', `/api/schedules/${encodeURIComponent(row!.name)}`, undefined, true);
    setSaving(false);
    if (r.ok) onClose();
    else setFailure(r.failure);
  };

  const title = mode === 'new' ? 'New job' : readOnly ? 'View job' : 'Edit job';
  return (
    <div className="sch-back" onClick={() => { if (!dirty || readOnly) onClose(); }}>
      <aside className="sch-drawer" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <h3 className="sch-dtitle">
          {title}
          {mode === 'edit' && row && <span className="sch-muted">{row.name}.md</span>}
          {mode === 'edit' && dirty && !readOnly && <span className="git-chip amber">unsaved</span>}
          {diskChanged && <span className="git-chip sch-red">on disk changed</span>}
          {readOnly && <span className="git-chip dim">read-only</span>}
        </h3>
        <div className="sch-dsub">
          {mode === 'new'
            ? <>Saved to <code>{ctl.dir}</code></>
            : !ctl.owner
              ? <>Read from <code>{ctl.dir}</code>; this server does not own the schedules, so it cannot save.</>
              : row?.installed
                ? <>Installed on this machine as <code>{ctl.machine === 'mac' ? launchdLabel(row.name) : row.name}</code></>
                : <>Not installed on this machine</>}
        </div>

        {asking && row ? (
          <div className="sch-confirm">
            <div className="sch-strong">Delete {row.name}?</div>
            <div className="sch-dsub">
              Removes the file from <code>{ctl.dir}</code> and the {ctl.machine === 'mac' ? 'launchd' : 'cron'} job from this machine. Runs stay in the log. The
              other machine drops it on its next pull.
            </div>
            {failure && <div className="sch-vmsg err">{failure}</div>}
            <div className="sch-dfoot">
              <button type="button" className="sch-btn sch-danger" disabled={saving || ctl.locked} onClick={() => { void remove(); }}>Delete file and job</button>
              <span className="sch-spacer" />
              <button type="button" className="sch-btn" onClick={() => (confirmDelete ? onClose() : setAsking(false))}>Keep</button>
            </div>
          </div>
        ) : (
          <>
            {mode === 'new' && (
              <div className="sch-field">
                <span className="sch-label">Kind</span>
                <div className="sch-kinds">
                  {KINDS.map(k => (
                    <button key={k.kind} type="button" aria-pressed={kind === k.kind} className={`sch-kind${kind === k.kind ? ' on' : ''}`}
                      onClick={() => { setKind(k.kind); setText(jobTemplate(k.kind)); setServerErrors(null); }}>
                      <b>{k.title}</b>
                      <span className="sch-hide">{k.line}<small>{k.small}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === 'new' && (
              <label className="sch-field">
                <span className="sch-label">Name</span>
                <span className="sch-in">
                  <input value={name} onChange={e => setName(e.target.value.trim())} placeholder="pull-pins" autoFocus spellCheck={false} autoCapitalize="off" />
                  <span className="sch-muted">{name ? `${name}.md` : '.md'}</span>
                </span>
                {name !== '' && nameErr && <span className="sch-vmsg err">{nameErr}</span>}
              </label>
            )}
            {!readOnly && (
              <div className="sch-field">
                <span className="sch-label">Repos</span>
                <div className="seg sch-sm" role="group" aria-label="Repos">
                  {([['all', ctl.phone ? 'All' : `All pinned (${pinNames.length})`], ['pick', 'Pick'], ['cwd', ctl.phone ? 'cwd' : 'Single cwd']] as const).map(([m, label]) => (
                    <button key={m} type="button" aria-pressed={repos.mode === m} className={repos.mode === m ? 'on' : ''} onClick={() => setMode(m)}>{label}</button>
                  ))}
                </div>
                {repos.mode === 'pick' && (
                  <div className="sch-picks">
                    {picks.map(n => (
                      <button key={n} type="button" aria-pressed={repos.picks.includes(n)} className={`sch-pick${repos.picks.includes(n) ? ' on' : ''}`} onClick={() => flipPick(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                )}
                <div className="sch-dsub sch-hide">
                  Writes the <code>foreach:</code> line below; a name not pinned on a machine is skipped there and noted in the run.
                </div>
              </div>
            )}
            <label className="sch-field">
              <span className="sch-label">File</span>
              {mode === 'edit' && loaded === null
                ? <span className="sch-dsub">{loadFailed ? 'Couldn’t read the file.' : 'Reading the file…'}</span>
                : (
                  <textarea className="sch-ta" value={text} readOnly={readOnly} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
                    rows={Math.min(24, Math.max(10, text.split('\n').length + 1))}
                    onChange={e => { setText(e.target.value); setServerErrors(null); }} />
                )}
              {errors.length > 0 && (
                <span className="sch-vmsg err">{errors.map(e => (e.line > 0 ? `line ${e.line}: ${e.message}` : e.message)).join(' · ')}</span>
              )}
              {errors.length === 0 && check?.summary && <span className="sch-vmsg ok">Valid · {check.summary}</span>}
              {editsWithoutAsking(text) && (
                <span className="sch-vmsg warn">permission-mode acceptEdits: the run can edit files in each repo without asking. bypassPermissions is refused here.</span>
              )}
            </label>
            {diskChanged && (
              <div className="sch-vmsg warn">
                The file changed on disk since it was opened. Reload it to save; your edits here are dropped.{' '}
                <button type="button" className="git-link" onClick={load}>Reload</button>
              </div>
            )}
            {failure && <div className="sch-vmsg err">{failure}</div>}
            <div className="sch-dfoot">
              {!readOnly && mode === 'new' && (
                <>
                  <button type="button" className="sch-btn sch-primary" disabled={!canSave} onClick={() => { void save(true); }}>Save and install</button>
                  <button type="button" className="sch-btn" disabled={!canSave} onClick={() => { void save(false); }}>{ctl.phone ? 'Keep paused' : 'Save, keep paused'}</button>
                </>
              )}
              {!readOnly && mode === 'edit' && (
                <button type="button" className="sch-btn sch-primary" disabled={!canSave} onClick={() => { void save(null); }}>Save and reconcile</button>
              )}
              <span className="sch-spacer" />
              {!readOnly && mode === 'edit' && <button type="button" className="sch-btn sch-danger" disabled={ctl.locked} onClick={() => setAsking(true)}>Delete…</button>}
              <button type="button" className="sch-btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
            </div>
            {!readOnly && mode === 'new' && (
              <div className="sch-dsub sch-hide">
                <b>Save and install</b> writes the file with <code>enabled: true</code> and reconciles. <b>Save, keep paused</b> writes <code>enabled: false</code>:
                the row appears, nothing is installed, and Run now still works, so a new job can be tried by hand first.
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
