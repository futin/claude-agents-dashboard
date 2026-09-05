import type { SessionsResponse, RateLimit, UsageLimits, UsageStatus } from '../../../shared/types';
import type { RemoteAnswerControl } from '../hooks/useRemoteAnswer';
import { formatResetTime } from '../lib/format';
import { holdCount } from '../lib/holds';
import { paceView, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../lib/pace';
import { OriginBadge } from './OriginBadge';
import { RemoteAnswerToggle } from './RemoteAnswerToggle';

/**
 * The status plate: one panel for everything true of the whole board rather
 * than of the list — the launch button, how this browser reached the server,
 * whether remote answers are allowed, the counts, the clock, and the account
 * gauges. Everything that filters or orders the list stays in the Toolbar
 * below, which is the whole point of the split.
 */
export function Header({ data, remoteAnswer, onOpenSpawn }: {
  data: SessionsResponse | null;
  /**
   * Owned by `SessionsView` and passed down rather than called here: the spawn
   * panel needs `spawnMaxPermission` off the same `/api/health` snapshot, and a
   * second `useRemoteAnswer()` call site would mean a second poll.
   */
  remoteAnswer: RemoteAnswerControl;
  /** Open the launch panel (its open/closed state lives in SessionsView). */
  onOpenSpawn: () => void;
}) {
  const meta = data ? new Date(data.generatedAt).toLocaleTimeString() : '';

  let sub: React.ReactNode = '';
  if (data) {
    const procs = data.runningClaudeProcs == null
      ? ''
      : ` · ${data.runningClaudeProcs} claude proc${data.runningClaudeProcs === 1 ? '' : 's'}`;
    // Every surface, not just the headless ones the banners cover: this mirrors
    // the row tabs (answer / plan? / reply? / allow?) one for one, so a count
    // labelled "need you" can never omit a row that visibly says it needs you.
    const holds = holdCount(data.sessions);
    sub = (
      <>
        <b>{data.totals.active}</b>{` active · top ${data.maxSessions}${procs}`}
        {/* No `title`: it is dead on touch, and this board is read on a phone. */}
        {holds > 0 && <span className="need-you">{holds} need you</span>}
      </>
    );
  }

  const message = data?.usageStatus ? USAGE_MESSAGES[data.usageStatus] : undefined;
  const bars = usageBars(data?.usage);
  const showUsage = Boolean(message) || bars.length > 0;

  // Nothing to frame yet — neither poll has answered. Drawing the plate here
  // would flash an empty bordered strip on every cold load.
  if (!data && !remoteAnswer.state && !showUsage) return null;

  return (
    <div className="plate">
      <div className="plate-row">
        {remoteAnswer.state?.spawnAvailable && (
          <button type="button" className="tb-new" onClick={onOpenSpawn}>
            + New
          </button>
        )}
        <OriginBadge origin={remoteAnswer.state?.origin} />
        <RemoteAnswerToggle control={remoteAnswer} />
        <span className="sub">{sub}</span>
        <span className="meta">{meta}</span>
      </div>
      {showUsage && (
        <>
          <div className="plate-div" />
          {message
            ? <UsageMessage text={message} />
            : <div className="usage">
                {bars.map(b => (
                  <UsageBar key={b.label} label={b.label} rl={b.rl} windowMs={b.windowMs} />
                ))}
              </div>}
        </>
      )}
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

/**
 * The rate-limit bars worth drawing. Returned rather than rendered so the plate
 * can ask whether there is a usage section *before* it commits to the divider
 * that separates one — an empty `.usage` under a rule reads as a broken panel.
 */
function usageBars(usage: UsageLimits | null | undefined) {
  if (!usage) return [];
  return [
    { label: '5h', rl: usage.fiveHour, windowMs: FIVE_HOUR_MS },
    { label: 'Week', rl: usage.sevenDay, windowMs: SEVEN_DAY_MS }
  ].filter((b) => b.rl.utilization != null);
}

/**
 * Shown instead of the bars when the token read explains itself. An expired
 * token renews on the CLI's next run and the following 3s poll flips
 * usageStatus back to 'ok'; a signed-out one waits for `claude auth login`.
 */
function UsageMessage({ text }: { text: string }) {
  return (
    <div className="usage">
      <span className="u-label">Usage</span>
      <span className="u-msg">{text}</span>
    </div>
  );
}

function UsageBar({ label, rl, windowMs }: { label: string; rl: RateLimit; windowMs: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(rl.utilization as number)));
  const level = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  const view = paceView(rl, windowMs);
  const title = rl.resetsAt
    ? `Window started ${formatResetTime(new Date(view!.startMs).toISOString())} · fully resets to 0% at ${formatResetTime(rl.resetsAt)}` +
      (view?.rateText ? ` · burning ${view.rateText}` : '') +
      // The mechanics stay stated in words, as they always have been here: the
      // band is the only place the duty cycle shows up otherwise.
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
