import type { ReactNode } from 'react';

import type { RoutineJobRow, RoutineRun, RoutineStep } from '../../../../shared/types';
import { useRoutineRuns } from '../../hooks/useRoutineRuns';
import { chipClass, formatStat, medianMs, runKicker, splitSteps, stepErrLine, stepPill, successRate } from '../../lib/routines';
import type { RoutineCtl } from './ctl';
import SessionLink from './SessionLink';

const RUNS_SHOWN = 3;
const OK_LINES = 4;

/**
 * A row folded open (spec §UI, screen 2): the job's own stats for the window and its last three runs, one line per step. A failed step of a fan-out job
 * can be run again on its repo alone; a claude step opens its session.
 */
export default function JobFold({ row, ctl, runBtn }: { row: RoutineJobRow; ctl: RoutineCtl; runBtn: ReactNode }) {
  const { data, error } = useRoutineRuns({ days: ctl.days, job: row.name, outcome: '', runner: '' });
  const s = data?.stats;
  const runs = [...(row.running ? [row.running] : []), ...(data?.runs ?? []).filter(r => r.id !== row.running?.id)].slice(0, RUNS_SHOWN);
  const path = `${ctl.dir.replace(/\/+$/, '')}/${row.name}.md`;

  return (
    <div className="rtn-runs">
      {s ? (
        <div className="rtn-fstats">
          <span><b>{s.runs}</b> runs · {ctl.days}d</span>
          <span><b>{formatStat(successRate(s), 'pct')}</b> ok</span>
          {s.costUsd > 0 && <span><b>{formatStat(s.costUsd, 'usd')}</b></span>}
          {s.tokensIn > 0 && <span className="rtn-hide"><b>{formatStat(s.tokensIn, 'tokens')}</b> in · {formatStat(s.tokensOut, 'tokens')} out</span>}
          {data && data.runs.length > 0 && <span className="rtn-hide"><b>{formatStat(medianMs(data.runs), 'ms')}</b> median</span>}
          <span className="rtn-muted rtn-hide">file: <code>{path}</code></span>
        </div>
      ) : (
        <div className="rtn-fstats rtn-muted">{error ? 'Couldn’t load this job’s runs.' : 'Loading runs…'}</div>
      )}
      {row.errors.length > 0 && (
        <div className="rtn-vmsg err">{row.errors.map(e => (e.line > 0 ? `line ${e.line}: ${e.message}` : e.message)).join(' · ')}</div>
      )}
      {data && runs.length === 0 && <div className="rtn-muted">No runs in the last {ctl.days}d.</div>}
      {runs.map((run, i) => <FoldRun key={run.id} run={run} row={row} ctl={ctl} first={i === 0} />)}
      {data && data.runs.length > 0 && (
        <div className="rtn-run">
          <button type="button" className="git-link rtn-wide" onClick={() => ctl.allRuns(row.name)}>all runs →</button>
        </div>
      )}
      <div className="rtn-phone rtn-fbtns">
        {runBtn}
        <button type="button" className="rtn-btn rtn-sm" onClick={() => ctl.edit(row.name)}>{ctl.owner ? 'Edit' : 'View'}</button>
      </div>
    </div>
  );
}

function FoldRun({ run, row, ctl, first }: { run: RoutineRun; row: RoutineJobRow; ctl: RoutineCtl; first: boolean }) {
  const { shown, hiddenOk } = splitSteps(run.steps, OK_LINES);
  return (
    <>
      <div className={`rtn-kick${first ? '' : ' rtn-gap'}`}>{runKicker(run, ctl.now)}</div>
      {run.error && <div className="rtn-err">{run.error}</div>}
      {run.why && run.state !== 'ok' && <div className="rtn-err">{run.why}</div>}
      {shown.map(step => <StepLine key={step.index} step={step} run={run} row={row} ctl={ctl} />)}
      {hiddenOk > 0 && <div className="rtn-run"><span className="rtn-muted rtn-wide">{hiddenOk} more ok</span></div>}
    </>
  );
}

/** One step: repo, duration, pill, cost and model (desktop only), then `run again` and `session →` where they apply. */
function StepLine({ step, run, row, ctl }: { step: RoutineStep; run: RoutineRun; row: RoutineJobRow | null; ctl: RoutineCtl }) {
  const pill = stepPill(step, run.state);
  const err = step.outcome !== null && step.outcome !== 'ok' && step.outcome !== 'skipped' ? stepErrLine(step) : step.outcome === 'skipped' ? step.why : null;
  const failed = step.outcome === 'failed' || step.outcome === 'timeout';
  const again = failed && step.repo !== null && row !== null && ctl.owner && row.onThisMachine && row.job !== null && !row.running;
  const name = step.repo ?? step.cwd?.replace(/\/+$/, '').split('/').pop() ?? run.job;
  const took = step.ms !== null ? formatStat(step.ms, 'ms') : run.state === 'running' && step.outcome === null ? formatStat(ctl.now.getTime() - Date.parse(step.startedAt), 'ms') : '—';

  return (
    <div className="rtn-run">
      <span className="rtn-cell">
        <span className="rtn-strong">{name}</span>
        {err && <span className="rtn-err">{err}</span>}
      </span>
      <span className="rtn-hide">{took}</span>
      <span><span className={chipClass(pill.tone)}>{pill.text}</span></span>
      <span className="rtn-hide">{step.costUsd !== null ? formatStat(step.costUsd, 'usd') : ''}</span>
      <span className="rtn-hide">{step.model ?? ''}</span>
      <span className="rtn-links">
        {again && (
          <button type="button" className="git-link" disabled={ctl.locked || ctl.busy === `run:${run.job}`} onClick={() => ctl.runNow(run.job, [step.repo!])}>run again</button>
        )}
        {step.sessionId && <SessionLink id={step.sessionId} ctl={ctl} />}
      </span>
    </div>
  );
}
