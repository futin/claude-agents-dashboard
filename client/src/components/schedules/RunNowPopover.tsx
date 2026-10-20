import { useState } from 'react';

import type { ScheduleJobRow } from '../../../../shared/types';
import { chipClass, pinOutcome } from '../../lib/schedules';
import type { ScheduleCtl } from './ctl';

/**
 * Run now on one repo (spec §UI, screen 5b): each of the job's pins with its outcome in the job's last run, a Run per pin and `Run the N failed`. Under
 * 640 px it is a bottom sheet with checkboxes, since a row of small Run buttons is too tight to tap. Run all sends no `only`; a pick sends the names, and
 * an empty pick is never sent — the server reads `only: []` as a caller bug.
 */
export default function RunNowPopover({ row, pins, ctl, onClose }: { row: ScheduleJobRow; pins: string[]; ctl: ScheduleCtl; onClose(): void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const outcomes = pins.map(name => ({ name, pill: pinOutcome(row.last, name) }));
  const failed = outcomes.filter(o => o.pill?.tone === 'red').map(o => o.name);
  const disabled = ctl.locked || ctl.busy === `run:${row.name}`;
  const run = (only?: string[]) => { onClose(); ctl.runNow(row.name, only); };

  if (ctl.phone) {
    const flip = (name: string) => setPicked(cur => (cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name]));
    return (
      <div className="sch-sheet-back" onClick={onClose}>
        <div className="sch-sheet" role="dialog" aria-label={`Run ${row.name} on some repos`} onClick={e => e.stopPropagation()}>
          <div className="sch-kick">Run {row.name} on · last run shown</div>
          <div className="sch-sheet-list">
            {outcomes.map(o => (
              <label key={o.name} className="sch-prow">
                <input type="checkbox" checked={picked.includes(o.name)} onChange={() => flip(o.name)} />
                <span className="sch-pname">{o.name}</span>
                {o.pill ? <span className={chipClass(o.pill.tone)}>{o.pill.text}</span> : <span className="sch-muted">not run</span>}
              </label>
            ))}
          </div>
          <div className="sch-pfoot">
            <button type="button" className="sch-btn sch-primary" disabled={disabled || picked.length === 0} onClick={() => run(picked)}>
              {picked.length > 0 ? `Run ${picked.length} selected` : 'Run selected'}
            </button>
            {failed.length > 0 && <button type="button" className="sch-btn" disabled={disabled} onClick={() => run(failed)}>Run the {failed.length} failed</button>}
            <span className="sch-spacer" />
            <button type="button" className="sch-btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sch-pop" role="dialog" aria-label={`Run ${row.name} on one repo`}>
      <div className="sch-kick">Run now on one repo · last run shown</div>
      <div className="sch-plist">
        {outcomes.length === 0 && <div className="sch-prow"><span className="sch-muted">No pinned repos on this machine.</span></div>}
        {outcomes.map(o => (
          <div key={o.name} className="sch-prow">
            <span className="sch-pname">{o.name}</span>
            {o.pill ? <span className={chipClass(o.pill.tone)}>{o.pill.text}</span> : <span className="sch-muted">not run</span>}
            <button type="button" className="sch-btn sch-sm" disabled={disabled} onClick={() => run([o.name])}>Run</button>
          </div>
        ))}
      </div>
      <div className="sch-pfoot">
        <span className="sch-muted">Runs the file as saved, cwd set to that repo.</span>
        <span className="sch-spacer" />
        {failed.length > 0 && <button type="button" className="sch-btn sch-sm" disabled={disabled} onClick={() => run(failed)}>Run the {failed.length} failed</button>}
        <button type="button" className="sch-btn sch-sm" disabled={disabled} onClick={() => run()}>Run all</button>
      </div>
    </div>
  );
}
