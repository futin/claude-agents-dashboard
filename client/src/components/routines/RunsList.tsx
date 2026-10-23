import { useEffect, useRef, useState, type RefObject } from 'react';

import type { RoutineJobRow, RoutineRun, RoutineStep } from '../../../../shared/types';
import { useRoutineRuns } from '../../hooks/useRoutineRuns';
import {
  chipClass, dotTone, formatStat, groupRunsByDay, isFanOut, runClock, runPill, splitSteps, stepErrLine, stepPill, type RoutineRunsQuery
} from '../../lib/routines';
import Chevron from '../Chevron';
import type { RoutineCtl } from './ctl';
import SessionLink from './SessionLink';

/**
 * The Runs page (spec §UI, screen 3): every run of the window, newest first, grouped by day. A fan-out run is one row with its steps folded; a run with a
 * failed step starts open with only the failures listed and the ok ones counted. `focusRun` (a deep link's `&run=`) starts open and is scrolled to once.
 */
export default function RunsList({ query, rows, ctl, focusRun }: { query: RoutineRunsQuery; rows: RoutineJobRow[]; ctl: RoutineCtl; focusRun: string | null }) {
  const { data, error } = useRoutineRuns(query);
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
      <div className="rtn-card rtn-clip">
        <div className="rtn-runrow rtn-head" aria-hidden="true">
          <span /><span>When</span><span>Job</span><span>Outcome</span><span>Took</span><span>Cost</span><span>Trigger</span><span />
        </div>
        {groupRunsByDay(data.runs, ctl.now).map(group => (
          <div key={group.label}>
            <div className="rtn-day">{group.label}</div>
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
      <div className="rtn-legend">
        <span className="rtn-muted">{failedRuns} failed run{failedRuns === 1 ? '' : 's'} in {query.days}d · {data.stats.runs} total</span>
      </div>
    </>
  );
}

function RunRow({ run, row, ctl, open, manual, onFlip, focusRef }: {
  run: RoutineRun; row: RoutineJobRow | null; ctl: RoutineCtl; open: boolean; manual: boolean; onFlip(): void;
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
      <div className={`rtn-runrow${open && fan ? ' rtn-folded' : ''}${fan && run.steps.length > 0 ? ' rtn-foldable' : ''}`} ref={focusRef}
        onClick={fan && run.steps.length > 0 ? onFlip : undefined}>
        <span className={`rtn-dot ${dotTone(pill, true)}`} />
        <span className="rtn-hide">{runClock(run)}</span>
        <span className="rtn-cell">
          <span className="rtn-strong">
            {run.job} <span className="rtn-phone rtn-muted">{runClock(run)}</span>
          </span>
          {err && <span className="rtn-err">{err}</span>}
          <span className="rtn-phone rtn-pline">
            <span className={chipClass(pill.tone)}>{pill.text}</span>
            <span className="rtn-muted">{[took, cost !== null ? formatStat(cost, 'usd') : '', run.trigger === 'manual' ? 'manual' : ''].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        <span className="rtn-hide"><span className={chipClass(pill.tone)}>{pill.text}</span></span>
        <span className="rtn-hide">{took}</span>
        <span className="rtn-hide">{cost !== null ? formatStat(cost, 'usd') : <span className="rtn-muted">{'—'}</span>}</span>
        <span className="rtn-hide rtn-muted">{trigger}</span>
        <span className="rtn-links">
          {fan && run.steps.length > 0 && (
            <button type="button" className="git-link" aria-expanded={open} aria-label={`${open ? 'Fold' : 'Unfold'} the steps of ${run.job}`}
              onClick={e => { e.stopPropagation(); onFlip(); }}>
              <span className="rtn-hide">fold </span><Chevron dir={open ? 'up' : 'down'} />
            </button>
          )}
          {only?.sessionId && <SessionLink id={only.sessionId} ctl={ctl} />}
        </span>
      </div>
      {open && fan && shown.map(step => <StepRow key={step.index} step={step} run={run} row={row} ctl={ctl} />)}
      {open && fan && hiddenOk > 0 && (
        <div className="rtn-runrow">
          <span /><span className="rtn-hide" /><span className="rtn-step rtn-muted">{hiddenOk} more ok</span>
        </div>
      )}
    </>
  );
}

function StepRow({ step, run, row, ctl }: { step: RoutineStep; run: RoutineRun; row: RoutineJobRow | null; ctl: RoutineCtl }) {
  const pill = stepPill(step, run.state);
  const failed = step.outcome === 'failed' || step.outcome === 'timeout';
  const err = step.outcome !== null && step.outcome !== 'ok' ? stepErrLine(step) : null;
  const again = failed && step.repo !== null && row !== null && ctl.owner && row.onThisMachine && row.job !== null && !row.running;
  return (
    <div className="rtn-runrow">
      <span />
      <span className="rtn-hide" />
      <span className="rtn-cell rtn-step">
        <span>{step.repo ?? run.job} <span className="rtn-phone"><span className={chipClass(pill.tone)}>{pill.text}</span></span></span>
        {err && <span className="rtn-err">{err}</span>}
      </span>
      <span className="rtn-hide"><span className={chipClass(pill.tone)}>{pill.text}</span></span>
      <span className="rtn-hide">{step.ms !== null ? formatStat(step.ms, 'ms') : '—'}</span>
      <span className="rtn-hide">{step.costUsd !== null ? formatStat(step.costUsd, 'usd') : ''}</span>
      <span className="rtn-hide" />
      <span className="rtn-links">
        {again && <button type="button" className="git-link" disabled={ctl.locked || ctl.busy === `run:${run.job}`} onClick={() => ctl.runNow(run.job, [step.repo!])}>run again</button>}
        {step.sessionId && <SessionLink id={step.sessionId} ctl={ctl} />}
      </span>
    </div>
  );
}
