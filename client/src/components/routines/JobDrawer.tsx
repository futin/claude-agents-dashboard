import { useEffect, useRef, useState } from 'react';

import { serializeEnabled, type JobError } from '../../../../shared/routine-file';
import type { RoutineErrorsResponse, RoutineFile, RoutineJobRow, RoutineValidateResponse } from '../../../../shared/types';
import { useAnswerToken } from '../../hooks/useAnswerToken';
import { useBackClose } from '../../hooks/useBackClose';
import type { RoutineWriteControl } from '../../hooks/useRoutineWrite';
import { authHeaders } from '../../lib/answerToken';
import { FIELDS, UNREADABLE } from '../../lib/routineForm';
import { editsWithoutAsking, jobTemplate, launchdLabel, nameProblem, type JobKind } from '../../lib/routines';
import type { RoutineCtl } from './ctl';
import JobRows from './JobRows';

const VALIDATE_MS = 300;

const KINDS: Array<{ kind: JobKind; title: string; line: string; small: string }> = [
  { kind: 'shell', title: 'Shell script', line: 'Runs a bash block. No tokens, no transcript.', small: 'exit code + last lines logged' },
  { kind: 'prompt', title: 'Claude prompt', line: 'Runs claude -p with the body as the prompt.', small: 'session + cost logged' },
  { kind: 'skill', title: 'Claude skill', line: 'Same, the body is one /skill line.', small: 'git-sync, docs-sync, kaizen…' }
];

/**
 * New job and Edit job (spec §UI, screens 4–5): one drawer over one text, shown as Form (`JobRows`, a summary row per setting, each control rewriting
 * only its own lines) or File (the raw textarea). The kind picker only fills a template. The text is checked against `/validate` as it is typed. An edit
 * whose file changed on disk since it was loaded (the row's `mtimeMs` moved) cannot be saved until it is reloaded, so a save never overwrites an edit
 * made elsewhere. A non-owner sees the file read-only.
 */
export default function JobDrawer({ mode, row, confirmDelete, existing, ctl, send, onClose }: {
  mode: 'new' | 'edit';
  row: RoutineJobRow | null;
  confirmDelete: boolean;
  existing: string[];
  ctl: RoutineCtl;
  send: RoutineWriteControl['send'];
  onClose(): void;
}) {
  const [token] = useAnswerToken();
  const [kind, setKind] = useState<JobKind>('shell');
  const [name, setName] = useState(mode === 'edit' && row ? row.name : '');
  const [text, setText] = useState(mode === 'new' ? jobTemplate('shell') : '');
  const [loaded, setLoaded] = useState<{ text: string; mtimeMs: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [check, setCheck] = useState<RoutineValidateResponse | null>(null);
  const [serverErrors, setServerErrors] = useState<JobError[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(confirmDelete);
  const [view, setView] = useState<'form' | 'file'>('form');
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
    fetch(`/api/routines/${encodeURIComponent(row.name)}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<RoutineFile>; })
      .then(file => { setText(file.text); setLoaded({ text: file.text, mtimeMs: file.mtimeMs }); setServerErrors(null); setFailure(null); })
      .catch(() => setLoadFailed(true));
  };
  useEffect(() => { if (mode === 'edit') load(); }, []);

  // Validate as typed; the seq drops an answer that a later keystroke already superseded.
  useEffect(() => {
    if (mode === 'edit' && loaded === null) return;
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      fetch('/api/routines/validate', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(fileName ? { text, name: fileName } : { text })
      })
        .then(res => (res.ok ? res.json() as Promise<RoutineValidateResponse> : null))
        .then(body => { if (mine === seq.current && body && Array.isArray(body.errors)) setCheck(body); })
        .catch(() => { /* the server's own check on Save still answers */ });
    }, VALIDATE_MS);
    return () => window.clearTimeout(timer);
  }, [text, fileName, loaded === null]);

  const edit = (next: string) => { setText(next); setServerErrors(null); };
  const sched = FIELDS.schedule.read(text);
  // A manual job installs nowhere, so New job's install-or-keep-paused choice means nothing for it: one Save, written enabled.
  const manual = sched !== UNREADABLE && sched.preset === 'manual';
  const reading = mode === 'edit' && loaded === null
    ? <span className="rtn-dsub">{loadFailed ? 'Couldn’t read the file.' : 'Reading the file…'}</span>
    : null;

  const nameErr = mode === 'new' ? nameProblem(name, existing) : null;
  const errors = serverErrors ?? check?.errors ?? [];
  const diskChanged = mode === 'edit' && row !== null && loaded !== null && row.mtimeMs !== loaded.mtimeMs;
  const dirty = mode === 'new' || (loaded !== null && text !== loaded.text);
  const canSave = !readOnly && !ctl.locked && !saving && !diskChanged && nameErr === null && errors.length === 0 && (mode === 'new' || (loaded !== null && dirty));

  const save = async (enabled: boolean | null) => {
    setSaving(true);
    setFailure(null);
    const r = mode === 'new'
      ? await send('Save', `save:${name}`, 'POST', '/api/routines', { name, text: serializeEnabled(text, enabled ?? true) }, true)
      : await send('Save', `save:${row!.name}`, 'PUT', `/api/routines/${encodeURIComponent(row!.name)}`, { text }, true);
    setSaving(false);
    if (r.ok) { onClose(); return; }
    // Still checked: a type is no proof of what an older server sends.
    const body = r.body as Partial<RoutineErrorsResponse> | null;
    if (r.status === 422 && body && Array.isArray(body.errors)) setServerErrors(body.errors);
    setFailure(r.failure);
  };

  const remove = async () => {
    setSaving(true);
    const r = await send('Delete', `delete:${row!.name}`, 'DELETE', `/api/routines/${encodeURIComponent(row!.name)}`, undefined, true);
    setSaving(false);
    if (r.ok) onClose();
    else setFailure(r.failure);
  };

  const title = mode === 'new' ? 'New job' : readOnly ? 'View job' : 'Edit job';
  return (
    <div className="rtn-back" onClick={() => { if (!dirty || readOnly) onClose(); }}>
      <aside className="rtn-drawer" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="rtn-f-head">
          <h3 className="rtn-dtitle">
            {title}
            {mode === 'edit' && row && <span className="rtn-muted">{row.name}.md</span>}
            {mode === 'edit' && dirty && !readOnly && <span className="git-chip amber">unsaved</span>}
            {diskChanged && <span className="git-chip rtn-red">on disk changed</span>}
            {readOnly && <span className="git-chip dim">read-only</span>}
          </h3>
          {!asking && (
            <div className="seg rtn-sm" role="group" aria-label="View">
              {(['form', 'file'] as const).map(v => (
                <button key={v} type="button" aria-pressed={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'form' ? 'Form' : 'File'}</button>
              ))}
            </div>
          )}
        </div>
        <div className="rtn-dsub">
          {mode === 'new'
            ? <>Saved to <code>{ctl.dir}</code></>
            : !ctl.owner
              ? <>Read from <code>{ctl.dir}</code>; this server does not own the routines, so it cannot save.</>
              : row?.installed
                ? <>Installed on this machine as <code>{ctl.machine === 'mac' ? launchdLabel(row.name) : row.name}</code></>
                : <>Not installed on this machine</>}
        </div>

        {asking && row ? (
          <div className="rtn-confirm">
            <div className="rtn-strong">Delete {row.name}?</div>
            <div className="rtn-dsub">
              Removes the file from <code>{ctl.dir}</code> and the {ctl.machine === 'mac' ? 'launchd' : 'cron'} job from this machine. Runs stay in the log. The
              other machine drops it on its next pull.
            </div>
            {failure && <div className="rtn-vmsg err">{failure}</div>}
            <div className="rtn-dfoot">
              <button type="button" className="rtn-btn rtn-danger" disabled={saving || ctl.locked} onClick={() => { void remove(); }}>Delete file and job</button>
              <span className="rtn-spacer" />
              <button type="button" className="rtn-btn" onClick={() => (confirmDelete ? onClose() : setAsking(false))}>Keep</button>
            </div>
          </div>
        ) : (
          <>
            {mode === 'new' && (
              <div className="rtn-field">
                <span className="rtn-label">Kind</span>
                <div className="rtn-kinds">
                  {KINDS.map(k => (
                    <button key={k.kind} type="button" aria-pressed={kind === k.kind} className={`rtn-kind${kind === k.kind ? ' on' : ''}`}
                      onClick={() => { setKind(k.kind); setText(jobTemplate(k.kind)); setServerErrors(null); }}>
                      <b>{k.title}</b>
                      <span className="rtn-hide">{k.line}<small>{k.small}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === 'new' && (
              <label className="rtn-field">
                <span className="rtn-label">Name</span>
                <span className="rtn-in">
                  <input value={name} onChange={e => setName(e.target.value.trim())} placeholder="pull-pins" autoFocus spellCheck={false} autoCapitalize="off" />
                  <span className="rtn-muted">{name ? `${name}.md` : '.md'}</span>
                </span>
                {name !== '' && nameErr && <span className="rtn-vmsg err">{nameErr}</span>}
              </label>
            )}
            {view === 'form' ? (
              <div className="rtn-field">
                {reading ?? <JobRows key={`${kind}:${loaded?.mtimeMs ?? ''}`} text={text} onText={edit} errors={errors} readOnly={readOnly} ctl={ctl} onFile={() => setView('file')} />}
                {errors.length === 0 && check?.summary && <span className="rtn-vmsg ok">Valid · {check.summary}</span>}
              </div>
            ) : (
              <label className="rtn-field">
                <span className="rtn-label">File</span>
                {reading ?? (
                  <textarea className="rtn-ta" value={text} readOnly={readOnly} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
                    rows={Math.min(24, Math.max(10, text.split('\n').length + 1))}
                    onChange={e => edit(e.target.value)} />
                )}
                {errors.length > 0 && (
                  <span className="rtn-vmsg err">{errors.map(e => (e.line > 0 ? `line ${e.line}: ${e.message}` : e.message)).join(' · ')}</span>
                )}
                {errors.length === 0 && check?.summary && <span className="rtn-vmsg ok">Valid · {check.summary}</span>}
                {editsWithoutAsking(text) && (
                  <span className="rtn-vmsg warn">permission-mode acceptEdits: the run can edit files in each repo without asking. bypassPermissions is refused here.</span>
                )}
              </label>
            )}
            {diskChanged && (
              <div className="rtn-vmsg warn">
                The file changed on disk since it was opened. Reload it to save; your edits here are dropped.{' '}
                <button type="button" className="git-link" onClick={load}>Reload</button>
              </div>
            )}
            {failure && <div className="rtn-vmsg err">{failure}</div>}
            <div className="rtn-dfoot">
              {!readOnly && mode === 'new' && manual && (
                <button type="button" className="rtn-btn rtn-primary" disabled={!canSave} onClick={() => { void save(true); }}>Save</button>
              )}
              {!readOnly && mode === 'new' && !manual && (
                <>
                  <button type="button" className="rtn-btn rtn-primary" disabled={!canSave} onClick={() => { void save(true); }}>Save and install</button>
                  <button type="button" className="rtn-btn" disabled={!canSave} onClick={() => { void save(false); }}>{ctl.phone ? 'Keep paused' : 'Save, keep paused'}</button>
                </>
              )}
              {!readOnly && mode === 'edit' && (
                <button type="button" className="rtn-btn rtn-primary" disabled={!canSave} onClick={() => { void save(null); }}>Save and reconcile</button>
              )}
              <span className="rtn-spacer" />
              {!readOnly && mode === 'edit' && <button type="button" className="rtn-btn rtn-danger" disabled={ctl.locked} onClick={() => setAsking(true)}>Delete…</button>}
              <button type="button" className="rtn-btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
            </div>
            {!readOnly && mode === 'new' && (
              <div className="rtn-dsub rtn-hide">
                {manual
                  ? <><b>Save</b> writes the file with <code>enabled: true</code>. A manual job is never installed; it runs only through Run now.</>
                  : <>
                    <b>Save and install</b> writes the file with <code>enabled: true</code> and reconciles. <b>Save, keep paused</b> writes{' '}
                    <code>enabled: false</code>: the row appears, nothing is installed, and Run now still works, so a new job can be tried by hand first.
                  </>}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
