import type { SessionsResponse, RateLimit, UsageLimits } from '../../../shared/types';

/** Title bar + summary line (generated time, active count, running claude procs). */
export function Header({ data }: { data: SessionsResponse | null }) {
  const meta = data ? new Date(data.generatedAt).toLocaleTimeString() : '';

  let sub: React.ReactNode = '';
  if (data) {
    const procs = data.runningClaudeProcs == null
      ? ''
      : ` · ${data.runningClaudeProcs} claude proc${data.runningClaudeProcs === 1 ? '' : 's'}`;
    sub = <><b>{data.totals.active}</b>{` active · top ${data.maxSessions}${procs}`}</>;
  }

  return (
    <>
      <div className="head">
        <h1>⚡ Claude Sessions</h1>
        <span className="meta">{meta}</span>
      </div>
      <div className="sub">{sub}</div>
      <UsageBars usage={data ? data.usage : null} />
    </>
  );
}

/** The two account rate-limit bars (5h + weekly). Renders nothing when unavailable. */
function UsageBars({ usage }: { usage: UsageLimits | null | undefined }) {
  if (!usage) return null;
  const bars = [
    { label: '5h', rl: usage.fiveHour },
    { label: 'Week', rl: usage.sevenDay }
  ].filter((b) => b.rl.utilization != null);
  if (bars.length === 0) return null;

  return (
    <div className="usage">
      {bars.map((b) => (
        <UsageBar key={b.label} label={b.label} rl={b.rl} />
      ))}
    </div>
  );
}

function UsageBar({ label, rl }: { label: string; rl: RateLimit }) {
  const pct = Math.max(0, Math.min(100, Math.round(rl.utilization as number)));
  const level = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  const title = rl.resetsAt ? `Resets ${new Date(rl.resetsAt).toLocaleString()}` : undefined;
  return (
    <div className="u" title={title}>
      <span className="u-label">{label}</span>
      <div className="u-bar">
        <div className={`u-fill ${level}`.trim()} style={{ width: `${pct}%` }} />
      </div>
      <span className="u-pct">{pct}%</span>
    </div>
  );
}
