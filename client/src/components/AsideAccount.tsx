import type { SessionsResponse, RateLimit, UsageLimits, UsageStatus } from '../../../shared/types';
import { formatResetTime } from '../lib/format';
import { paceView, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../lib/pace';

/**
 * The Account card in the sessions aside: the two rate-limit gauges (5h, Week)
 * with their time strips — the status plate's gauges, on a card of their own.
 * Renders nothing while there is nothing to draw (SHOW_USAGE off, or no poll
 * yet), so the aside never frames an empty card.
 */
export function AsideAccount({ data }: { data: SessionsResponse | null }) {
  const message = data?.usageStatus ? USAGE_MESSAGES[data.usageStatus] : undefined;
  const bars = usageBars(data?.usage);
  if (!message && bars.length === 0) return null;

  return (
    <div className="s-card">
      <div className="ct">Account</div>
      <div className="cs">Both rate windows, from the account usage endpoint</div>
      {message
        ? <div className="usage"><span className="u-msg">{message}</span></div>
        : <div className="usage">
            {bars.map(b => <UsageBar key={b.label} label={b.label} rl={b.rl} windowMs={b.windowMs} />)}
          </div>}
    </div>
  );
}

/**
 * Statuses that replace the bars with a line of their own. A lookup rather than
 * a ternary chain, so a fourth status is a row here and nothing else. Anything
 * absent from this map falls through to the bars — `unavailable` stays silent
 * because most of what lands there is not something the reader can act on.
 *
 * `signed-out` names the fix in **visible text**: `title` never fires on touch
 * and this board is read on a phone. The dashboard cannot log the user in
 * itself — OAuth login is an interactive terminal + browser flow — so naming
 * the command is the whole remedy.
 */
const USAGE_MESSAGES: Partial<Record<UsageStatus, string>> = {
  'token-expired': 'token expired',
  'signed-out': 'signed out — run claude auth login'
};

/** The rate-limit bars worth drawing — those with a utilization reading. */
function usageBars(usage: UsageLimits | null | undefined) {
  if (!usage) return [];
  return [
    { label: '5h', rl: usage.fiveHour, windowMs: FIVE_HOUR_MS },
    { label: 'Week', rl: usage.sevenDay, windowMs: SEVEN_DAY_MS }
  ].filter((b) => b.rl.utilization != null);
}

function UsageBar({ label, rl, windowMs }: { label: string; rl: RateLimit; windowMs: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(rl.utilization as number)));
  const level = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  const view = paceView(rl, windowMs);
  const title = rl.resetsAt
    ? `Window started ${formatResetTime(new Date(view!.startMs).toISOString())} · fully resets to 0% at ${formatResetTime(rl.resetsAt)}` +
      (view?.rateText ? ` · burning ${view.rateText}` : '') +
      (rl.dutyCycle != null ? ` · working ~${Math.round(rl.dutyCycle * 100)}% of the hours left` : '')
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
        <span className={`u-pct ${level}`.trim()}>{pct}%</span>
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
 *
 * Two ticks, not one, once the weekly window has a duty-cycle forecast: the
 * best estimate and the pessimistic "you work every remaining hour" edge. The
 * *band* between them is drawn only while confidence is below `ok` — once the
 * profile is trustworthy the two converge in meaning and a band would imply
 * doubt that is no longer there. Both ticks always render, so both edges of the
 * estimate are always visible.
 */
function TimeStrip({ view, resetsAt }: { view: NonNullable<ReturnType<typeof paceView>>; resetsAt: string }) {
  return (
    <>
      <div className="u-time-row">
        <div className="u-time">
          <div className="u-time-fill" style={{ width: `${view.elapsedPct}%` }} />
          {view.wallPct != null && view.wallPctPessimistic != null && view.confidence !== 'ok' && (
            <div
              className="u-band"
              style={{
                left: `${Math.min(view.wallPct, view.wallPctPessimistic)}%`,
                width: `${Math.abs(view.wallPct - view.wallPctPessimistic)}%`
              }}
            />
          )}
          <div className="u-tick now" style={{ left: `${view.elapsedPct}%` }} />
          {view.wallPct != null && <div className="u-tick wall" style={{ left: `${view.wallPct}%` }} />}
          {view.wallPctPessimistic != null && (
            <div className="u-tick wall-pessimistic" style={{ left: `${view.wallPctPessimistic}%` }} />
          )}
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
