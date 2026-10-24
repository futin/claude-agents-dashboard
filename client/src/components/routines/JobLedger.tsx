import { useEffect, useRef, useState } from 'react';

import type { RoutineJobRow } from '../../../../shared/types';
import { describeCron, isManualCron, parseCron } from '../../../../shared/cron';
import { chipClass, dotTone, jobPins, pausedLook, rowText, splitNext, withLate } from '../../lib/routines';
import Chevron from '../Chevron';
import type { RoutineCtl } from './ctl';
import JobFold from './JobFold';
import JobMenu from './JobMenu';
import RunNowPopover from './RunNowPopover';

/** The ledger: one row per job file, sorted by name by the server. One row is folded open at a time; one menu or popover is open at a time. */
export default function JobLedger({ rows, ctl }: { rows: RoutineJobRow[]; ctl: RoutineCtl }) {
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ name: string; kind: 'menu' | 'pop' } | null>(null);

  if (rows.length === 0) {
    return (
      <div className="rtn-card">
        <div className="git-empty">
          No jobs yet. {ctl.owner ? 'New job writes the first file to ' : 'Job files live in '}<code>{ctl.dir}</code>.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="rtn-card">
        <div className="rtn-ledger rtn-head" aria-hidden="true">
          <span /><span>Job</span><span>Runner</span><span>Last run</span><span>Next</span><span>{ctl.owner ? 'On' : ''}</span><span />
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
      <div className="rtn-legend rtn-hide">
        <span className="rtn-dot ok" />last run ok <span className="rtn-dot warn" />some failed <span className="rtn-dot bad" />failed
        <span className="rtn-dot live" />running <span className="rtn-dot off" />paused
        <span className="git-chip dim">shell</span>no tokens <span className="git-chip rtn-runner">claude</span>claude -p
      </div>
    </>
  );
}

function Row({ row, ctl, folded, onFold, menu, setMenu }: {
  row: RoutineJobRow; ctl: RoutineCtl; folded: boolean; onFold(): void;
  menu: 'menu' | 'pop' | null; setMenu(kind: 'menu' | 'pop' | null): void;
}) {
  const job = row.job;
  const { lastLine, nextLine, pill } = rowText(row, ctl.now);
  const line = withLate(lastLine, !row.running && row.last?.late === true);
  const [day, clock] = splitNext(nextLine);
  const dot = dotTone(pill, !pausedLook(job));
  const runnable = ctl.owner && row.onThisMachine && job !== null;
  const busy = ctl.busy === `run:${row.name}`;
  const actRef = useRef<HTMLSpanElement>(null);
  const closeRef = useRef(setMenu);
  closeRef.current = setMenu;

  // A tap outside the row's controls closes its menu or popover; Escape does too.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => { if (!actRef.current?.contains(e.target as Node)) closeRef.current(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const cron = job ? parseCron(job.cron) : null;
  const when = cron?.ok ? describeCron(cron.cron) : job?.cron ?? row.errors[0]?.message ?? 'invalid file';
  const fan = job ? fanChip(job.foreach, job.cwd, ctl) : null;

  const runBtn = runnable && (row.running
    ? <button type="button" className="rtn-btn rtn-sm" disabled={ctl.locked || busy} onClick={() => ctl.stop(row.name)}>Stop</button>
    : <button type="button" className="rtn-btn rtn-sm" disabled={ctl.locked || busy} onClick={() => ctl.runNow(row.name)}>Run now</button>);
  // A manual job is never installed, so an on/off switch would promise something the file cannot do.
  const toggle = ctl.owner && job && !isManualCron(job.cron) && (
    <button type="button" role="switch" aria-checked={job.enabled} aria-label={job.enabled ? `Pause ${row.name}` : `Resume ${row.name}`}
      className={`rtn-tog${job.enabled ? ' on' : ''}`} disabled={ctl.locked || ctl.busy === `toggle:${row.name}`}
      onClick={() => ctl.toggle(row.name, !job.enabled)} />
  );

  return (
    <>
      <div className={`rtn-ledger${folded ? ' rtn-folded' : ''}`} onClick={onFold}>
        <span className={`rtn-dot ${dot}`} />
        <div className="rtn-cell">
          <button type="button" className={`rtn-name${pausedLook(job) ? ' rtn-muted' : ''}`} aria-expanded={folded} onClick={e => { e.stopPropagation(); onFold(); }}>
            {row.name}
          </button>
          <div className="rtn-sub">
            <span className="rtn-muted">{when}</span>
            {fan && <span className="git-chip dim rtn-mach">{ctl.phone ? fan.short : fan.long}</span>}
            {job?.machines.map(m => (
              <span key={m} className={`git-chip rtn-mach${m === ctl.machine ? ' rtn-here' : ''} rtn-hide`}>{m}</span>
            ))}
            {job && !row.onThisMachine && <span className="git-chip rtn-mach rtn-phone">{job.machines.join(' + ')} only</span>}
          </div>
          {(row.onThisMachine || job === null) && (
            <div className="rtn-phone rtn-pline">
              {line && <span className="rtn-muted">{line}</span>}
              <span className={chipClass(pill.tone)}>{pill.text}</span>
            </div>
          )}
        </div>
        <span className="rtn-hide">{job ? <span className={chipClass(job.run === 'claude' ? 'run' : 'dim')}>{job.run}</span> : null}</span>
        <div className="rtn-cell rtn-hide">
          <span className={chipClass(pill.tone)}>{pill.text}</span>
          {line && <span className="rtn-muted">{line}</span>}
        </div>
        <div className="rtn-cell rtn-hide">
          {clock === null ? <span className="rtn-muted">{day}</span> : <><span>{day}</span><span className="rtn-muted">{clock}</span></>}
        </div>
        <span className="rtn-hide" onClick={e => e.stopPropagation()}>{toggle}</span>
        <span className="rtn-act" ref={actRef} onClick={e => e.stopPropagation()}>
          <span className="rtn-hide">{runBtn}</span>
          <span className="rtn-phone">{toggle}</span>
          <button type="button" className={`rtn-btn rtn-sm rtn-icon${menu ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={menu !== null} aria-label={`More for ${row.name}`}
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
function fanChip(foreach: 'pinned' | string[] | null, cwd: string | null, ctl: RoutineCtl): { long: string; short: string } | null {
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
