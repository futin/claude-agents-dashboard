import { describeCron, nextAfter, parseCron } from '../../../../shared/cron';
import { useDraft } from '../../hooks/useDraft';
import { cronFor, pad2, type Preset, type Schedule } from '../../lib/routineForm';
import { nextText } from '../../lib/routines';

const PRESETS: Array<[Preset, string]> = [
  ['manual', 'Manual'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['custom', 'Custom']
];
const EVERY = [1, 2, 3, 6, 12] as const;
/** Monday first, as the mockup's chips read; the numbers are cron's (0 = Sunday). */
const DAYS: Array<[number, string]> = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

function nextFire(cron: string, now: Date): string {
  const p = parseCron(cron);
  const at = p.ok ? nextAfter(p.cron, now) : null;
  return at ? nextText(at, now) : '—';
}

function TimeField({ hour, minute, disabled, set }: { hour: number; minute: number; disabled: boolean; set(hour: number, minute: number): void }) {
  // A time input reports '' until every segment is filled, so only a whole HH:MM is written.
  const d = useDraft<HTMLInputElement>(`${pad2(hour)}:${pad2(minute)}`, s => set(Number(s.slice(0, 2)), Number(s.slice(3, 5))), s => /^\d{2}:\d{2}/.test(s));
  return (
    <div className="rtn-f-row">
      <span className="rtn-f-at">At</span>
      <span className="rtn-in rtn-f-time"><input type="time" aria-label="Time" disabled={disabled} {...d} /></span>
    </div>
  );
}

function HourlyFields({ value, disabled, onChange }: { value: Extract<Schedule, { preset: 'hourly' }>; disabled: boolean; onChange(s: Schedule): void }) {
  const d = useDraft<HTMLInputElement>(String(value.minute), s => onChange({ ...value, minute: Number(s.trim()) }),
    s => /^\d{1,2}$/.test(s.trim()) && Number(s) <= 59);
  return (
    <div className="rtn-f-row">
      <span className="rtn-f-at">At minute</span>
      <span className="rtn-in rtn-f-num"><input inputMode="numeric" aria-label="Minute" disabled={disabled} {...d} /></span>
      <span className="rtn-f-at">every</span>
      <div className="seg rtn-sm" role="group" aria-label="Every">
        {EVERY.map(n => (
          <button key={n} type="button" aria-pressed={value.every === n} className={value.every === n ? 'on' : ''} disabled={disabled}
            onClick={() => onChange({ ...value, every: n })}>{n}h</button>
        ))}
      </div>
    </div>
  );
}

function CustomFields({ text, now, disabled, onChange }: { text: string; now: Date; disabled: boolean; onChange(s: Schedule): void }) {
  // Every keystroke is written, parse or not: the validator's error then shows in the row, which is how a cron gets fixed (spec §Schedule presets).
  const d = useDraft<HTMLInputElement>(text, s => onChange({ preset: 'custom', text: s }));
  const p = parseCron(text);
  return (
    <>
      <div className="rtn-f-row">
        <span className="rtn-in rtn-f-grow">
          <input aria-label="Cron" disabled={disabled} spellCheck={false} autoCapitalize="off" autoCorrect="off" {...d} />
          <span className="rtn-muted">min hr day mon wkday</span>
        </span>
      </div>
      {p.ok && <div className="rtn-f-hint"><b>{describeCron(p.cron)}</b> · next: {nextFire(text, now)}</div>}
    </>
  );
}

/**
 * The Schedule row's control (spec §Schedule presets): the six-preset seg, each preset's own inputs, and the cron line it writes with its next fire.
 * `onPick` is a seg click and `onChange` an edit inside a preset; `routineForm.ts`'s `schedulePick` / `scheduleEdit` decide what reaches the file, since
 * Weekly with no day writes nothing.
 */
export default function ScheduleControl({ value, now, disabled, onPick, onChange }: {
  value: Schedule;
  now: Date;
  disabled: boolean;
  onPick(p: Preset): void;
  onChange(s: Schedule): void;
}) {
  const cron = cronFor(value);
  return (
    <>
      <div className="seg rtn-sm" role="group" aria-label="Schedule">
        {PRESETS.map(([p, label]) => (
          <button key={p} type="button" aria-pressed={value.preset === p} className={value.preset === p ? 'on' : ''} disabled={disabled}
            onClick={() => onPick(p)}>{label}</button>
        ))}
      </div>
      {value.preset === 'manual' && (
        <>
          <div className="rtn-f-hint">
            Runs only when you press <b>Run now</b>. Nothing is installed on any machine, and the ledger shows <i>manual</i> with no next fire.
          </div>
          <div className="rtn-f-hint">Writes <code>cron: manual</code></div>
        </>
      )}
      {value.preset === 'hourly' && <HourlyFields value={value} disabled={disabled} onChange={onChange} />}
      {(value.preset === 'daily' || value.preset === 'weekdays') && (
        <TimeField hour={value.hour} minute={value.minute} disabled={disabled} set={(hour, minute) => onChange({ ...value, hour, minute })} />
      )}
      {value.preset === 'weekly' && (
        <>
          <div className="rtn-picks">
            {DAYS.map(([n, label]) => {
              const on = value.days.includes(n);
              return (
                <button key={n} type="button" aria-pressed={on} className={`rtn-pick${on ? ' on' : ''}`} disabled={disabled}
                  onClick={() => onChange({ ...value, days: (on ? value.days.filter(d => d !== n) : [...value.days, n]).sort((a, b) => a - b) })}>
                  {label}
                </button>
              );
            })}
          </div>
          <TimeField hour={value.hour} minute={value.minute} disabled={disabled} set={(hour, minute) => onChange({ ...value, hour, minute })} />
          {value.days.length === 0 && <span className="rtn-vmsg err">Pick at least one day; nothing is written until one is.</span>}
        </>
      )}
      {value.preset === 'custom' && <CustomFields text={value.text} now={now} disabled={disabled} onChange={onChange} />}
      {cron !== null && value.preset !== 'manual' && value.preset !== 'custom' && (
        <div className="rtn-f-hint">Next: {nextFire(cron, now)} · writes <code>cron: "{cron}"</code></div>
      )}
    </>
  );
}
