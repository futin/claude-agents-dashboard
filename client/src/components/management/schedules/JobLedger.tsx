import { useEffect, useRef, useState } from 'react';

import type { ScheduleJobRow } from '../../../../../shared/types';
import { describeCron, parseCron } from '../../../../../shared/cron';
import { chipClass, dotTone, jobPins, rowText, splitNext, withLate } from '../../../lib/schedules';
import Chevron from '../../Chevron';
import type { ScheduleCtl } from './ctl';
import JobFold from './JobFold';
import JobMenu from './JobMenu';
import RunNowPopover from './RunNowPopover';

/** The ledger: one row per job file, sorted by name by the server. One row is folded open at a time; one menu or popover is open at a time. */
export default function JobLedger({ rows, ctl }: { rows: ScheduleJobRow[]; ctl: ScheduleCtl }) {
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ name: string; kind: 'menu' | 'pop' } | null>(null);

  if (rows.length === 0) {
    return (
      <div className="sch-card">
        <div className="git-empty">
          No jobs yet. {ctl.owner ? 'New job writes the first file to ' : 'Job files live in '}<code>{ctl.dir}</code>.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sch-card">
        <div className="sch-ledger sch-head" aria-hidden="true">
          <span /><span>Job</span><span>Runner</span><span>Last run</span><span>Next</span><span>On</span><span />
        </div>
        {rows.map(row => (
          <Row
            key={row.name}
            row={row}
            ctl={ctl}
            folded={open === row.name}
            onFold={() => setOpen(cur => (cur === row.name ? null : row.name))}
            menu={menu?.name === row.name ? menu.kind : null}
            setMenu={kind => setMenu(kind ? { name: row.name, kind } : null)}
          />
        ))}
      </div>
      <div className="sch-legend sch-hide">
        <span className="sch-dot ok" />last run ok <span className="sch-dot warn" />some failed <span className="sch-dot bad" />failed
        <span className="sch-dot live" />running <span className="sch-dot off" />paused
        <span className="git-chip dim">shell</span>no tokens <span className="git-chip sch-run">claude</span>claude -p
      </div>
    </>
  );
}

function Row({ row, ctl, folded, onFold, menu, setMenu }: {
  row: ScheduleJobRow; ctl: ScheduleCtl; folded: boolean; onFold(): void;
  menu: 'menu' | 'pop' | null; setMenu(kind: 'menu' | 'pop' | null): void;
}) {
  const job = row.job;
  const { lastLine, nextLine, pill } = rowText(row, ctl.now);
  const line = withLate(lastLine, !row.running && row.last?.late === true);
  const [day, clock] = splitNext(nextLine);
  const dot = dotTone(pill, job?.enabled ?? true);
  const runnable = ctl.owner && row.onThisMachine && job !== null;
  const busy = ctl.busy === `run:${row.name}`;
  const actRef = useRef<HTMLSpanElement>(null);

  // A tap outside the row's controls closes its menu or popover; Escape does too.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!actRef.current?.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu, setMenu]);

  const cron = job ? parseCron(job.cron) : null;
  const when = cron?.ok ? describeCron(cron.cron) : job?.cron ?? row.errors[0]?.message ?? 'invalid file';
  const fan = job ? fanChip(job.foreach, job.cwd, ctl) : null;

  const runBtn = runnable && (row.running
    ? <button type="button" className="sch-btn sch-sm" disabled={ctl.locked || busy} onClick={() => ctl.stop(row.name)}>Stop</button>
    : <button type="button" className="sch-btn sch-sm" disabled={ctl.locked || busy} onClick={() => ctl.runNow(row.name)}>Run now</button>);
  const toggle = ctl.owner && job && (
    <button type="button" role="switch" aria-checked={job.enabled} aria-label={job.enabled ? `Pause ${row.name}` : `Resume ${row.name}`}
      className={`sch-tog${job.enabled ? ' on' : ''}`} disabled={ctl.locked || ctl.busy === `toggle:${row.name}`}
      onClick={() => ctl.toggle(row.name, !job.enabled)} />
  );

  return (
    <>
      <div className={`sch-ledger${folded ? ' sch-folded' : ''}`} onClick={onFold}>
        <span className={`sch-dot ${dot}`} />
        <div className="sch-cell">
          <button type="button" className={`sch-name${job?.enabled === false ? ' sch-muted' : ''}`} aria-expanded={folded} onClick={e => { e.stopPropagation(); onFold(); }}>
            {row.name}
          </button>
          <div className="sch-sub">
            <span className="sch-muted">{when}</span>
            {fan && <span className="git-chip dim sch-mach">{ctl.phone ? fan.short : fan.long}</span>}
            {job?.machines.map(m => (
              <span key={m} className={`git-chip sch-mach${m === ctl.machine ? ' sch-here' : ''} sch-hide`}>{m}</span>
            ))}
            {job && !row.onThisMachine && <span className="git-chip sch-mach sch-phone">{job.machines.join(' + ')} only</span>}
          </div>
          {(row.onThisMachine || job === null) && (
            <div className="sch-phone sch-pline">
              {line && <span className="sch-muted">{line}</span>}
              <span className={chipClass(pill.tone)}>{pill.text}</span>
            </div>
          )}
        </div>
        <span className="sch-hide">{job ? <span className={chipClass(job.run === 'claude' ? 'run' : 'dim')}>{job.run}</span> : null}</span>
        <div className="sch-cell sch-hide">
          <span className={chipClass(pill.tone)}>{pill.text}</span>
          {line && <span className="sch-muted">{line}</span>}
        </div>
        <div className="sch-cell sch-hide">
          {clock === null ? <span className="sch-muted">{day}</span> : <><span>{day}</span><span className="sch-muted">{clock}</span></>}
        </div>
        <span className="sch-hide">{toggle}</span>
        <span className="sch-act" ref={actRef} onClick={e => e.stopPropagation()}>
          <span className="sch-hide">{runBtn}</span>
          <span className="sch-phone">{toggle}</span>
          <button type="button" className={`sch-btn sch-sm sch-icon${menu ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={menu !== null} aria-label={`More for ${row.name}`}
            onClick={() => setMenu(menu ? null : 'menu')}>
            <Chevron dir={menu ? 'up' : 'down'} />
          </button>
          {menu === 'menu' && <JobMenu row={row} ctl={ctl} onClose={() => setMenu(null)} onRunOne={() => setMenu('pop')} />}
          {menu === 'pop' && job && <RunNowPopover row={row} pins={jobPins(job.foreach, ctl.pins)} ctl={ctl} onClose={() => setMenu(null)} />}
        </span>
      </div>
      {folded && <JobFold row={row} ctl={ctl} runBtn={runBtn || null} />}
    </>
  );
}

/** The fan-out chip: `× 14 pinned` (`× 14` on a phone), `× 3` for a list, or the cwd a single-cwd job runs in. */
function fanChip(foreach: 'pinned' | string[] | null, cwd: string | null, ctl: ScheduleCtl): { long: string; short: string } | null {
  if (foreach === 'pinned') {
    const n = jobPins('pinned', ctl.pins).length;
    return { long: `× ${n} pinned`, short: `× ${n}` };
  }
  if (Array.isArray(foreach)) return { long: `× ${foreach.length}`, short: `× ${foreach.length}` };
  if (cwd) {
    const base = cwd.replace(/\/+$/, '').split('/').pop() ?? cwd;
    return { long: `…/${base}`, short: base };
  }
  return null;
}
