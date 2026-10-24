import { useId, useState } from 'react';

import type { JobError } from '../../../../shared/routine-file';
import { useDraft } from '../../hooks/useDraft';
import {
  FIELDS, UNREADABLE, cronFor, fmValue, formKind, frontmatterReadable, routeErrors, switchPreset, visibleFields,
  type FieldDef, type FieldId, type FormKind, type Limits, type Machines, type ModelEffort, type Permission, type Preset, type Repos, type Schedule,
  type Summary, type Tools
} from '../../lib/routineForm';
import { jobPins } from '../../lib/routines';
import { EFFORTS, MODELS } from '../../lib/spawnOptions';
import Chevron from '../Chevron';
import type { RoutineCtl } from './ctl';
import ScheduleControl from './ScheduleControl';

type Val<K extends FieldId> = (typeof FIELDS)[K] extends FieldDef<infer V> ? V : never;

const PERMISSIONS = ['plan', 'acceptEdits', 'auto'] as const;
const WHOLE_COUNT = /^\s*([1-9]\d*)?\s*$/;

function Seg<T extends string | null>({ label, options, value, disabled, pick }: {
  label: string; options: Array<[T, string]>; value: T; disabled: boolean; pick(v: T): void;
}) {
  return (
    <div className="seg rtn-sm" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={text} type="button" aria-pressed={value === v} className={value === v ? 'on' : ''} disabled={disabled} onClick={() => pick(v)}>{text}</button>
      ))}
    </div>
  );
}

function MachinesControl({ v, ctl, disabled, put }: { v: Machines; ctl: RoutineCtl; disabled: boolean; put(v: Machines): void }) {
  return (
    <>
      <div className="rtn-picks">
        {(['mac', 'wsl'] as const).map(m => (
          <button key={m} type="button" aria-pressed={v[m]} className={`rtn-pick${v[m] ? ' on' : ''}`} disabled={disabled}
            onClick={() => put(m === 'mac' ? { ...v, mac: !v.mac } : { ...v, wsl: !v.wsl })}>
            {m}{ctl.machine === m && <span className="rtn-f-here">this machine</span>}
          </button>
        ))}
      </div>
      <div className="rtn-f-hint">
        Which machines install this job. This dashboard is <b>{ctl.machine}</b>: detected from the OS, or set by <code>ROUTINE_MACHINE</code> in{' '}
        <code>.env</code>.
      </div>
    </>
  );
}

function ReposControl({ v, ctl, disabled, put }: { v: Repos; ctl: RoutineCtl; disabled: boolean; put(v: Repos): void }) {
  const listId = useId();
  const pinNames = jobPins('pinned', ctl.pins);
  const paths = ctl.pins.filter(p => p.listed && p.path !== null).map(p => p.path as string);
  const cwd = useDraft<HTMLInputElement>(v.cwd, s => put({ ...v, cwd: s }));
  const picks = [...v.picks, ...pinNames.filter(n => !v.picks.includes(n))];
  const setMode = (mode: Repos['mode']) => {
    if (mode === v.mode) return;
    // Pick starts from every pin, so switching from All pinned changes nothing that runs until a chip is turned off.
    put(mode === 'pick' ? { mode, picks: v.picks.length > 0 ? v.picks : pinNames, cwd: v.cwd } : { mode, picks: [], cwd: v.cwd });
  };
  const flip = (n: string) => put({ ...v, picks: v.picks.includes(n) ? v.picks.filter(x => x !== n) : [...v.picks, n] });
  const labels = ctl.phone ? ['All', 'Pick', 'Folder'] : ['All pinned', 'Pick', 'One folder'];
  return (
    <>
      <Seg label="Repos" value={v.mode} disabled={disabled} pick={setMode}
        options={[['all', labels[0]], ['pick', labels[1]], ['cwd', labels[2]]]} />
      {v.mode === 'all' && (
        <>
          <div className="rtn-picks">{pinNames.map(n => <span key={n} className="rtn-pick rtn-f-ro">{n}</span>)}</div>
          <div className="rtn-f-hint">One run in each repo pinned on the dashboard, today and later. Writes <code>foreach: pinned</code></div>
        </>
      )}
      {v.mode === 'pick' && (
        <>
          <div className="rtn-picks">
            {picks.map(n => (
              <button key={n} type="button" aria-pressed={v.picks.includes(n)} className={`rtn-pick${v.picks.includes(n) ? ' on' : ''}`} disabled={disabled}
                onClick={() => flip(n)}>{n}</button>
            ))}
          </div>
          <div className="rtn-f-hint">A repo that isn't pinned on a machine is skipped there, and the run notes it.</div>
        </>
      )}
      {v.mode === 'cwd' && (
        <>
          <div className="rtn-f-row">
            <span className="rtn-in rtn-f-grow">
              <input aria-label="Folder" list={listId} placeholder="~/Documents/notes" disabled={disabled} spellCheck={false} autoCapitalize="off" {...cwd} />
            </span>
            <datalist id={listId}>{paths.map(p => <option key={p} value={p} />)}</datalist>
          </div>
          <div className="rtn-f-hint">Suggests the pinned repos' paths, or type any folder. Empty = the routines folder's parent.</div>
        </>
      )}
    </>
  );
}

function BodyControl({ label, v, disabled, put }: { label: 'Script' | 'Prompt'; v: string; disabled: boolean; put(v: string): void }) {
  const d = useDraft<HTMLTextAreaElement>(v, put);
  return (
    <>
      <textarea className="rtn-ta" aria-label={label} readOnly={disabled} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
        rows={Math.min(16, Math.max(3, d.value.split('\n').length + 1))} {...d} />
      <div className="rtn-f-hint">
        {label === 'Script'
          ? <>The inside of the <code>```bash</code> block. The fence is written for you.</>
          : <>Everything below the frontmatter. A skill job is one <code>/skill</code> line.</>}
      </div>
    </>
  );
}

function ModelControl({ v, disabled, put }: { v: ModelEffort; disabled: boolean; put(v: ModelEffort): void }) {
  // The file takes any one-token model, so free text is allowed; a space mid-word stays local until it is gone.
  const d = useDraft<HTMLInputElement>(v.model ?? '', s => put({ ...v, model: s.trim() || null }), s => /^\S*$/.test(s.trim()));
  return (
    <>
      <div className="rtn-field">
        <span className="rtn-label">Model</span>
        <span className="rtn-in"><input aria-label="Model" placeholder="CLI default" disabled={disabled} spellCheck={false} autoCapitalize="off" {...d} /></span>
        <div className="rtn-picks">
          {([null, ...MODELS] as const).map(m => (
            <button key={m ?? 'default'} type="button" aria-pressed={v.model === m} className={`rtn-pick${v.model === m ? ' on' : ''}`} disabled={disabled}
              onClick={() => put({ ...v, model: m })}>{m ?? 'Default'}</button>
          ))}
        </div>
      </div>
      <div className="rtn-field rtn-f-last">
        <span className="rtn-label">Effort</span>
        <Seg label="Effort" value={v.effort} disabled={disabled} pick={effort => put({ ...v, effort })}
          options={[[null, 'Default'], ...EFFORTS.map((e): [string, string] => [e, e])]} />
      </div>
    </>
  );
}

function PermissionControl({ v, disabled, put }: { v: Permission; disabled: boolean; put(v: Permission): void }) {
  return (
    <>
      <Seg label="Permission" value={v} disabled={disabled} pick={put} options={[[null, 'Default'], ...PERMISSIONS.map((p): [string, string] => [p, p])]} />
      {v === 'plan' && <div className="rtn-f-hint"><b>plan</b>: reads and plans, edits nothing.</div>}
      {v === 'acceptEdits' && <span className="rtn-vmsg warn">The run can edit files in each repo without asking. bypassPermissions is refused here.</span>}
    </>
  );
}

function LimitsControl({ v, kind, disabled, put }: { v: Limits; kind: FormKind; disabled: boolean; put(v: Limits): void }) {
  const parsed = /^(\d+)([smh])$/.exec(v.timeout ?? '');
  const [unitPick, setUnitPick] = useState<'s' | 'm' | 'h'>('m');
  // The file's unit wins; the local pick only matters while no timeout is written, so a unit can be chosen before the number.
  const unit = (parsed?.[2] as 's' | 'm' | 'h' | undefined) ?? unitPick;
  const turns = useDraft<HTMLInputElement>(v.maxTurns ?? '', s => put({ ...v, maxTurns: s.trim() || null }), s => WHOLE_COUNT.test(s));
  const amount = useDraft<HTMLInputElement>(parsed ? parsed[1] : v.timeout ?? '', s => put({ ...v, timeout: s.trim() ? `${s.trim()}${unit}` : null }),
    s => WHOLE_COUNT.test(s));
  const pickUnit = (u: 's' | 'm' | 'h') => {
    setUnitPick(u);
    if (parsed) put({ ...v, timeout: `${parsed[1]}${u}` });
  };
  return (
    <>
      <div className={kind === 'claude' ? 'rtn-f-two' : undefined}>
        {kind === 'claude' && (
          <div className="rtn-field">
            <span className="rtn-label">Max turns</span>
            <span className="rtn-in"><input inputMode="numeric" aria-label="Max turns" disabled={disabled} {...turns} /><span className="rtn-muted">blank = no cap</span></span>
          </div>
        )}
        <div className="rtn-field rtn-f-last">
          <span className="rtn-label">Timeout</span>
          <div className="rtn-f-row rtn-f-tight">
            <span className="rtn-in rtn-f-num"><input inputMode="numeric" aria-label="Timeout" placeholder="1" disabled={disabled} {...amount} /></span>
            <Seg label="Timeout unit" value={unit} disabled={disabled} pick={pickUnit} options={[['s', 's'], ['m', 'm'], ['h', 'h']]} />
          </div>
        </div>
      </div>
      <div className="rtn-f-hint">Blank timeout = the 1h default.</div>
    </>
  );
}

function ToolsControl({ v, disabled, put }: { v: Tools; disabled: boolean; put(v: Tools): void }) {
  const [add, setAdd] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const submit = () => {
    const t = add.trim();
    if (t === '') return;
    // The file holds the tools as one inline list, so a comma would split one name into two.
    if (t.includes(',')) { setRefused('One tool at a time: a name cannot contain a comma.'); return; }
    if (!v.includes(t)) put([...v, t]);
    setAdd('');
    setRefused(null);
  };
  return (
    <>
      <div className="rtn-picks">
        {v.map(t => (
          <button key={t} type="button" className="rtn-pick on" aria-label={`Remove ${t}`} disabled={disabled} onClick={() => put(v.filter(x => x !== t))}>
            {t} ×
          </button>
        ))}
        <button type="button" className="rtn-pick rtn-f-add" disabled={disabled || add.trim() === ''} onClick={submit}>+ add</button>
      </div>
      <div className="rtn-f-row">
        <span className="rtn-in rtn-f-grow">
          <input aria-label="Add tool" placeholder="Tool name, e.g. Edit or Bash(pnpm test:*)" value={add} disabled={disabled} spellCheck={false} autoCapitalize="off"
            onChange={e => { setAdd(e.target.value); setRefused(null); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
        </span>
      </div>
      {refused && <span className="rtn-vmsg err">{refused}</span>}
      <div className="rtn-f-hint">Empty = any tool.</div>
    </>
  );
}

/**
 * The drawer's Form view (spec §Rows): one summary row per field the job's kind shows, one opened at a time. The text stays the only state: every control
 * edit is `FIELDS[id].write(text, v)` handed to `onText`, and each closed row reads its value back out of the text on every render. Errors from
 * `/validate` are routed to the row that owns their line; the rest show under the rows.
 */
export default function JobRows({ text, onText, errors, readOnly, ctl, onFile }: {
  text: string;
  onText(next: string): void;
  errors: JobError[];
  readOnly: boolean;
  ctl: RoutineCtl;
  onFile(): void;
}) {
  const [open, setOpen] = useState<FieldId | null>(null);
  // The Schedule row's own view while it is open: Weekly before a day is picked has no cron to write, and Custom stays Custom while its text is typed
  // even when the text already reads as a preset, so the input never vanishes under the caret.
  const [schedView, setSchedView] = useState<Schedule | null>(null);

  const kind = formKind(text);
  const readable = frontmatterReadable(text);
  const { byField, rest } = routeErrors(text, errors, kind);
  const ctx = { pinCount: jobPins('pinned', ctl.pins).length, kind };

  const put = <K extends FieldId>(id: K, v: Val<K>) => onText((FIELDS[id] as unknown as FieldDef<Val<K>>).write(text, v));
  const applySchedule = (s: Schedule) => {
    const cron = cronFor(s);
    setSchedView(s.preset === 'custom' || cron === null ? s : null);
    if (cron !== null) put('schedule', s);
  };
  const pickPreset = (current: Schedule, p: Preset) => {
    if (p === current.preset) return;
    // Custom starts from the cron as the file has it and writes nothing until it is typed in.
    if (p === 'custom') setSchedView({ preset: 'custom', text: fmValue(text, 'cron')?.value ?? '' });
    else applySchedule(switchPreset(current, p));
  };

  const control = (id: FieldId, value: unknown) => {
    const disabled = readOnly;
    switch (id) {
      case 'schedule': {
        const v = schedView ?? (value as Schedule);
        return <ScheduleControl value={v} now={ctl.now} disabled={disabled} onPick={p => pickPreset(v, p)} onChange={applySchedule} />;
      }
      case 'machines': return <MachinesControl v={value as Machines} ctl={ctl} disabled={disabled} put={v => put('machines', v)} />;
      case 'repos': return <ReposControl v={value as Repos} ctl={ctl} disabled={disabled} put={v => put('repos', v)} />;
      case 'script': return <BodyControl label="Script" v={value as string} disabled={disabled} put={v => put('script', v)} />;
      case 'prompt': return <BodyControl label="Prompt" v={value as string} disabled={disabled} put={v => put('prompt', v)} />;
      case 'model': return <ModelControl v={value as ModelEffort} disabled={disabled} put={v => put('model', v)} />;
      case 'permission': return <PermissionControl v={value as Permission} disabled={disabled} put={v => put('permission', v)} />;
      case 'limits': return <LimitsControl v={value as Limits} kind={kind} disabled={disabled} put={v => put('limits', v)} />;
      case 'tools': return <ToolsControl v={value as Tools} disabled={disabled} put={v => put('tools', v)} />;
    }
  };

  return (
    <>
      <div className="rtn-f-rows">
        {visibleFields(kind).map(id => {
          const def = FIELDS[id] as unknown as FieldDef<unknown>;
          const value = def.read(text);
          const errs = byField[id] ?? [];
          const isOpen = open === id;
          let sum: Summary = value === UNREADABLE
            ? { text: 'edit in File', tone: 'dim' }
            : def.summary(id === 'schedule' && isOpen && schedView ? schedView : value, ctx);
          if (errs.length > 0) sum = { ...sum, tone: 'err' };
          return (
            <div key={id} className={`rtn-f-ar${isOpen ? ' open' : ''}`}>
              <button type="button" className="rtn-f-arh" aria-expanded={isOpen} onClick={() => { setOpen(isOpen ? null : id); setSchedView(null); }}>
                <span className="rtn-f-k">{def.label}</span>
                <span className={`rtn-f-val${sum.tone === 'set' ? '' : ` ${sum.tone}`}`}>{sum.text}</span>
                <Chevron dir={isOpen ? 'down' : 'right'} />
              </button>
              {isOpen && (
                <div className="rtn-f-arb rtn-f-ctl">
                  {value === UNREADABLE
                    ? <div className="rtn-f-hint">This value can't be shown as a form. <button type="button" className="git-link" onClick={onFile}>Edit in File</button></div>
                    : control(id, value)}
                  {errs.length > 0 && <span className="rtn-vmsg err">{errs.map(e => e.message).join(' · ')}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!readable && (
        <div className="rtn-vmsg err">
          This file can't be read as a form — fix it in <button type="button" className="git-link" onClick={onFile}>File</button>.
        </div>
      )}
      {rest.length > 0 && (
        <span className="rtn-vmsg err">{rest.map(e => (e.line > 0 ? `line ${e.line}: ${e.message}` : e.message)).join(' · ')}</span>
      )}
    </>
  );
}
