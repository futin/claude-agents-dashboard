import type { SessionsResponse, RateLimit, UsageLimits } from '../../../shared/types';
import { formatResetTime } from '../lib/format';
import { paceView, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../lib/pace';

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
        <span className="meta">{meta}</span>
      </div>
      <div className="sub">{sub}</div>
      {data?.usageStatus === 'token-expired'
        ? <UsageExpired />
        : <UsageBars usage={data ? data.usage : null} />}
    </>
  );
}

/**
 * Shown instead of the bars when the stored OAuth token is expired. The CLI
 * renews its own token the next time it runs; the following 3s poll flips
 * usageStatus back to 'ok' and the bars return on their own.
 */
function UsageExpired() {
  return (
    <div className="usage">
      <span className="u-label">Usage</span>
      <span className="u-msg">token expired</span>
    </div>
  );
}

/** The two account rate-limit bars (5h + weekly). Renders nothing when unavailable. */
function UsageBars({ usage }: { usage: UsageLimits | null | undefined }) {
  if (!usage) return null;
  const bars = [
    { label: '5h', rl: usage.fiveHour, windowMs: FIVE_HOUR_MS },
    { label: 'Week', rl: usage.sevenDay, windowMs: SEVEN_DAY_MS }
  ].filter((b) => b.rl.utilization != null);
  if (bars.length === 0) return null;

  return (
    <div className="usage">
      {bars.map((b) => (
        <UsageBar key={b.label} label={b.label} rl={b.rl} windowMs={b.windowMs} />
      ))}
    </div>
  );
}

function UsageBar({ label, rl, windowMs }: { label: string; rl: RateLimit; windowMs: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(rl.utilization as number)));
  const level = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  const view = paceView(rl, windowMs);
  const title = rl.resetsAt
    ? `Window started ${formatResetTime(new Date(view!.startMs).toISOString())} · fully resets to 0% at ${formatResetTime(rl.resetsAt)}` +
      (view?.rateText ? ` · burning ${view.rateText}` : '')
    : undefined;
  return (
    <div className="u" title={title}>
      <div className="u-top">
        <span className="u-label">{label}</span>
        {rl.resetsAt && (
          <span className="u-reset">
            {view?.rateText ? `${view.rateText} · ` : ''}resets {formatResetTime(rl.resetsAt)}
          </span>
        )}
      </div>
      <div className="u-row">
        <div className="u-bar">
          <div className={`u-fill ${level}`.trim()} style={{ width: `${pct}%` }} />
        </div>
        <span className="u-pct">{pct}%</span>
      </div>
      {view && <TimeStrip view={view} resetsAt={rl.resetsAt as string} />}
    </div>
  );
}

/**
 * The window-as-time strip under the usage bar (one axis is tokens, this one
 * is time): elapsed fill + a "now" tick, a red tick where the current pace
 * projects 100%, and a wall/lasts verdict on the right. Quiet until the
 * server has enough samples to know the pace.
 */
function TimeStrip({ view, resetsAt }: { view: NonNullable<ReturnType<typeof paceView>>; resetsAt: string }) {
  return (
    <>
      <div className="u-time-row">
        <div className="u-time">
          <div className="u-time-fill" style={{ width: `${view.elapsedPct}%` }} />
          <div className="u-tick now" style={{ left: `${view.elapsedPct}%` }} />
          {view.wallPct != null && <div className="u-tick wall" style={{ left: `${view.wallPct}%` }} />}
        </div>
        <span className="u-time-spacer" />
      </div>
      <div className="u-time-labels">
        <span>{formatResetTime(new Date(view.startMs).toISOString())}</span>
        {view.verdict === 'wall' && view.wallMs != null && (
          <span className="u-verdict wall">
            wall {formatResetTime(new Date(view.wallMs).toISOString())} ▮ reset {formatResetTime(resetsAt)}
          </span>
        )}
        {view.verdict === 'lasts' && <span className="u-verdict lasts">lasts → {formatResetTime(resetsAt)}</span>}
      </div>
    </>
  );
}
