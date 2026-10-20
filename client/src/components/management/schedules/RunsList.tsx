import { useEffect, useRef, useState, type RefObject } from 'react';

import type { ScheduleJobRow, ScheduleRun, ScheduleStep } from '../../../../../shared/types';
import { useScheduleRuns } from '../../../hooks/useScheduleRuns';
import {
  chipClass, dotTone, formatStat, groupRunsByDay, isFanOut, runClock, runPill, splitSteps, stepErrLine, stepPill, type ScheduleRunsQuery
} from '../../../lib/schedules';
import Chevron from '../../Chevron';
import type { ScheduleCtl } from './ctl';
import SessionLink from './SessionLink';

/**
 * The Runs page (spec §UI, screen 3): every run of the window, newest first, grouped by day. A fan-out run is one row with its steps folded; a run with a
 * failed step starts open with only the failures listed and the ok ones counted. `focusRun` (a deep link's `&run=`) starts open and is scrolled to once.
 */
export default function RunsList({ query, rows, ctl, focusRun }: { query: ScheduleRunsQuery; rows: ScheduleJobRow[]; ctl: ScheduleCtl; focusRun: string | null }) {
  const { data, error } = useScheduleRuns(query);
  const [flip, setFlip] = useState<Record<string, boolean>>({});
  const focusRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const byName = new Map(rows.map(r => [r.name, r]));

  useEffect(() => {
    if (scrolled.current || !focusRun || !data) return;
    scrolled.current = true;
    focusRef.current?.scrollIntoView({ block: 'center' });
  }, [data, focusRun]);

  if (data === null) return <div className="git-empty">{error ? 'Couldn’t load the runs.' : 'Loading runs…'}</div>;
  if (data.runs.length === 0) return <div className="git-empty">No runs in the last {query.days}d{query.outcome || query.runner || query.job ? ' that match' : ''}.</div>;

  const failedRuns = data.stats.failed + data.stats.lost;
  return (
    <>
      <div className="sch-card sch-clip">
        <div className="sch-runrow sch-head" aria-hidden="true">
          <span /><span>When</span><span>Job</span><span>Outcome</span><span>Took</span><span>Cost</span><span>Trigger</span><span />
        </div>
        {groupRunsByDay(data.runs, ctl.now).map(group => (
          <div key={group.label}>
            <div className="sch-day">{group.label}</div>
            {group.runs.map(run => {
              const auto = run.id === focusRun || (isFanOut(run) && run.failed > 0);
              const open = flip[run.id] ?? auto;
              return (
                <RunRow key={run.id} run={run} row={byName.get(run.job) ?? null} ctl={ctl} open={open} manual={flip[run.id] === true || (run.id === focusRun && flip[run.id] === undefined)}
                  onFlip={() => setFlip(f => ({ ...f, [run.id]: !open }))} focusRef={run.id === focusRun ? focusRef : undefined} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="sch-legend">
        <span className="sch-muted">{failedRuns} failed run{failedRuns === 1 ? '' : 's'} in {query.days}d · {data.stats.runs} total</span>
      </div>
    </>
  );
}

function RunRow({ run, row, ctl, open, manual, onFlip, focusRef }: {
  run: ScheduleRun; row: ScheduleJobRow | null; ctl: ScheduleCtl; open: boolean; manual: boolean; onFlip(): void;
  focusRef?: RefObject<HTMLDivElement>;
}) {
  const pill = runPill(run);
  const fan = isFanOut(run);
  const only = !fan ? run.steps[0] ?? null : null;
  const cost = run.steps.reduce<number | null>((sum, s) => (s.costUsd === null ? sum : (sum ?? 0) + s.costUsd), null);
  const took = run.ms !== null ? formatStat(run.ms, 'ms') : run.state === 'running' ? `${formatStat(ctl.now.getTime() - Date.parse(run.startedAt), 'ms')} so far` : '—';
  const err = run.error ?? (run.state === 'lost' || run.state === 'refused' ? run.why : null) ?? (only && only.outcome !== 'ok' && only.outcome !== null ? stepErrLine(only) : null);
  // Opened by default, a fold lists the failures and counts the rest; opened by hand, it lists every step.
  const { shown, hiddenOk } = splitSteps(run.steps, manual ? run.steps.length : 0);
  const trigger = run.trigger === 'manual' ? 'manual' : 'schedule';

  return (
    <>
      <div className={`sch-runrow${open && fan ? ' sch-folded' : ''}${fan && run.steps.length > 0 ? ' sch-foldable' : ''}`} ref={focusRef}
        onClick={fan && run.steps.length > 0 ? onFlip : undefined}>
        <span className={`sch-dot ${dotTone(pill, true)}`} />
        <span className="sch-hide">{runClock(run)}</span>
        <span className="sch-cell">
          <span className="sch-strong">
            {run.job} <span className="sch-phone sch-muted">{runClock(run)}</span>
          </span>
          {err && <span className="sch-err">{err}</span>}
          <span className="sch-phone sch-pline">
            <span className={chipClass(pill.tone)}>{pill.text}</span>
            <span className="sch-muted">{[took, cost !== null ? formatStat(cost, 'usd') : '', run.trigger === 'manual' ? 'manual' : ''].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        <span className="sch-hide"><span className={chipClass(pill.tone)}>{pill.text}</span></span>
        <span className="sch-hide">{took}</span>
        <span className="sch-hide">{cost !== null ? formatStat(cost, 'usd') : <span className="sch-muted">{'—'}</span>}</span>
        <span className="sch-hide sch-muted">{trigger}</span>
        <span className="sch-links">
          {fan && run.steps.length > 0 && (
            <button type="button" className="git-link" aria-expanded={open} aria-label={`${open ? 'Fold' : 'Unfold'} the steps of ${run.job}`}
              onClick={e => { e.stopPropagation(); onFlip(); }}>
              <span className="sch-hide">fold </span><Chevron dir={open ? 'up' : 'down'} />
            </button>
          )}
          {only?.sessionId && <SessionLink id={only.sessionId} ctl={ctl} />}
        </span>
      </div>
      {open && fan && shown.map(step => <StepRow key={step.index} step={step} run={run} row={row} ctl={ctl} />)}
      {open && fan && hiddenOk > 0 && (
        <div className="sch-runrow">
          <span /><span className="sch-hide" /><span className="sch-step sch-muted">{hiddenOk} more ok</span>
        </div>
      )}
    </>
  );
}

function StepRow({ step, run, row, ctl }: { step: ScheduleStep; run: ScheduleRun; row: ScheduleJobRow | null; ctl: ScheduleCtl }) {
  const pill = stepPill(step, run.state);
  const failed = step.outcome === 'failed' || step.outcome === 'timeout';
  const err = step.outcome !== null && step.outcome !== 'ok' ? stepErrLine(step) : null;
  const again = failed && step.repo !== null && row !== null && ctl.owner && row.onThisMachine && row.job !== null && !row.running;
  return (
    <div className="sch-runrow">
      <span />
      <span className="sch-hide" />
      <span className="sch-cell sch-step">
        <span>{step.repo ?? run.job} <span className="sch-phone"><span className={chipClass(pill.tone)}>{pill.text}</span></span></span>
        {err && <span className="sch-err">{err}</span>}
      </span>
      <span className="sch-hide"><span className={chipClass(pill.tone)}>{pill.text}</span></span>
      <span className="sch-hide">{step.ms !== null ? formatStat(step.ms, 'ms') : '—'}</span>
      <span className="sch-hide">{step.costUsd !== null ? formatStat(step.costUsd, 'usd') : ''}</span>
      <span className="sch-hide" />
      <span className="sch-links">
        {again && <button type="button" className="git-link" disabled={ctl.locked || ctl.busy === `run:${run.job}`} onClick={() => ctl.runNow(run.job, [step.repo!])}>run again</button>}
        {step.sessionId && <SessionLink id={step.sessionId} ctl={ctl} />}
      </span>
    </div>
  );
}
