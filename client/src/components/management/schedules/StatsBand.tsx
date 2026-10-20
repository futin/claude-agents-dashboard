import type { ScheduleJobRow, ScheduleRunsResponse } from '../../../../../shared/types';
import { costDelta, formatStat, successRate, topFailure, topTokenShare } from '../../../lib/schedules';

/**
 * The Jobs page's band: the window summed over every job (spec §UI, screen 1). Five tiles, Runs and Cost only at phone width. Until the runs answer the
 * tiles draw with dashes, so the ledger under them does not jump when they land.
 */
export default function StatsBand({ data, days, jobs }: { data: ScheduleRunsResponse | null; days: number; jobs: ScheduleJobRow[] }) {
  const s = data?.stats ?? null;
  const runs = data?.runs ?? [];
  const delta = s ? costDelta(s, days) : null;
  const fail = topFailure(runs);
  const share = topTokenShare(runs);
  const shell = new Set(jobs.filter(j => j.job?.run === 'shell').map(j => j.name));
  const shellMs = runs.reduce((sum, r) => sum + (shell.has(r.job) ? r.ms ?? 0 : 0), 0);
  const peak = s ? Math.max(1, ...s.byDay.map(d => d.ok + d.failed)) : 1;
  const dash = '—';

  return (
    <div className="sch-stats">
      <div className="sch-stat">
        <div className="sch-k">Runs · {days}d</div>
        <div className="sch-v">
          {s ? s.runs : dash}
          {s && <small>{s.ok} ok · {s.failed + s.lost} failed</small>}
        </div>
        {s && (
          <div className="sch-bars sch-hide" aria-hidden="true">
            {s.byDay.map(d => {
              const n = d.ok + d.failed;
              return <i key={d.day} className={n === 0 ? 'none' : d.failed > 0 ? 'bad' : ''} style={n === 0 ? undefined : { height: `${Math.max(10, Math.round((n / peak) * 100))}%` }} />;
            })}
          </div>
        )}
      </div>
      <div className="sch-stat sch-hide">
        <div className="sch-k">Success</div>
        <div className="sch-v">{s ? formatStat(successRate(s), 'pct') : dash}</div>
        {fail && <div className="sch-d">{fail}</div>}
      </div>
      <div className="sch-stat">
        <div className="sch-k">Claude cost · {days}d</div>
        <div className="sch-v">{s ? formatStat(s.costUsd, 'usd') : dash}</div>
        {delta && <div className={`sch-d${delta.dir ? ` ${delta.dir}` : ''}`}>{delta.text}</div>}
      </div>
      <div className="sch-stat sch-hide">
        <div className="sch-k">Tokens</div>
        <div className="sch-v">
          {s ? formatStat(s.tokensIn, 'tokens') : dash}
          {s && <small>in · {formatStat(s.tokensOut, 'tokens')} out</small>}
        </div>
        {share && <div className="sch-d">{share.job} is {formatStat(share.share, 'pct')} of it</div>}
      </div>
      <div className="sch-stat sch-hide">
        <div className="sch-k">Wall time</div>
        <div className="sch-v">{s ? formatStat(s.wallMs, 'ms') : dash}</div>
        {s && shellMs > 0 && <div className="sch-d">shell jobs: {formatStat(shellMs, 'ms')} of it</div>}
      </div>
    </div>
  );
}
