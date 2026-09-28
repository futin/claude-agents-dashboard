import { useCallback, useRef, useState } from 'react';

import type { AccountResponse, RateLimit, UsageLimits, UsageStatus } from '../../../shared/types';
import { formatResetTime } from '../lib/format';
import { paceView, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../lib/pace';
import type { Section } from '../lib/sections';
import { useDismiss } from './Popover';

/**
 * The account chip in the shell's header band — who you are and both rate
 * windows, in one pill, above every section.
 *
 * This was the Account card in the sessions aside. It moved because it is the
 * one block on that aside that is not about the board: the 5-hour and weekly
 * windows are true of the account wherever you are standing, and reading them
 * required being on Sessions. The card's contents did not change — the popover
 * draws the same gauges, ticks and verdicts the card drew, from the same
 * `paceView` — only where they hang.
 *
 * Three states, and they are the four `UsageStatus` values folded to what the
 * reader can do about them:
 *   ok / (SHOW_USAGE off)  → the profile chip, with meters when there are any
 *   signed-out             → an empty ring, the state, and `claude auth login`
 *   token-expired          → the same shape, saying it renews itself
 *   unavailable            → nothing at all, unless there is still a profile to
 *                            name; most of what lands there is not actionable.
 *
 * The remedy is VISIBLE TEXT, never a `title`: this board is read on a phone,
 * where `title` never fires, and the dashboard cannot sign anyone in — OAuth
 * login is an interactive terminal + browser flow — so naming the command is
 * the whole of what it can offer.
 */
export function HeaderAccount({ account, onGo }: {
  account: AccountResponse | null;
  /** Jump to a section from the popover's footer. */
  onGo: (s: Section) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);

  const profile = account?.profile ?? null;
  const status = account?.usageStatus;
  const bars = usageBars(account?.usage);
  const out = outState(status);

  // Cold poll, or `unavailable` with nothing to name: draw no chip rather than
  // an empty one. The band is then simply empty, which is what it was before.
  if (!account) return null;
  if (!out && !profile && bars.length === 0) return null;

  return (
    <div className="acct-anchor" ref={anchor}>
      <button
        type="button"
        className={`acct${out ? ' out' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={out ? out.chip : `Account${profile?.name ? `, ${profile.name}` : ''}`}
        onClick={() => setOpen(v => !v)}
      >
        {out ? (
          <>
            <PersonRing />
            <span className="nm">{out.chip}</span>
            <span className="dotwarn" aria-hidden="true" />
          </>
        ) : (
          <>
            <span className="av" aria-hidden="true">{initial(profile)}</span>
            {profile?.name && <span className="nm">{profile.name}</span>}
            {bars.length > 0 && (
              <span className="meters">
                {bars.map(b => {
                  const pct = clampPct(b.rl.utilization as number);
                  return (
                    <span key={b.label} className="m">
                      <span className="mtop"><span>{b.short}</span><b>{pct}%</b></span>
                      <span className="mini"><i className={level(pct)} style={{ width: `${pct}%` }} /></span>
                    </span>
                  );
                })}
              </span>
            )}
          </>
        )}
        <Caret />
      </button>
      {open && (
        <div className="acct-pop" role="dialog" aria-label="Account">
          {out ? <SignedOut out={out} /> : <SignedIn profile={profile} bars={bars} onGo={onGo} close={close} />}
        </div>
      )}
    </div>
  );
}

/** The identity block, the two gauges, and the two places worth going next. */
function SignedIn({ profile, bars, onGo, close }: {
  profile: AccountResponse['profile'];
  bars: ReturnType<typeof usageBars>;
  onGo: (s: Section) => void;
  close: () => void;
}) {
  const go = (s: Section) => (): void => { onGo(s); close(); };
  return (
    <>
      {profile && (
        <div className="acct-id">
          <span className="av" aria-hidden="true">{initial(profile)}</span>
          <span className="who3">
            {profile.name && <span className="n">{profile.name}</span>}
            {profile.email && <span className="e">{profile.email}</span>}
            {/* Tiers as they are, not as a claim: a tier the server could not
                label is simply absent, never guessed at. */}
            <span className="acct-tags">
              {profile.plan && <span className="on">{profile.plan}</span>}
              {profile.organization && <span>{profile.organization}</span>}
              {profile.seat && <span>{profile.seat}</span>}
              {profile.extraUsage && <span>Extra usage</span>}
            </span>
          </span>
        </div>
      )}
      {bars.length > 0 && (
        <div className="usage">
          {bars.map(b => <UsageBar key={b.label} label={b.label} rl={b.rl} windowMs={b.windowMs} />)}
        </div>
      )}
      <div className="acct-foot">
        <button type="button" onClick={go('usage')}>Usage detail</button>
        <button type="button" onClick={go('settings')}>Settings</button>
      </div>
    </>
  );
}

/** No windows to draw, so the popover is the sentence and the fix. */
function SignedOut({ out }: { out: OutState }) {
  return (
    <>
      <div className="out-head">
        <PersonRing large />
        <span className="n">{out.title}</span>
      </div>
      <div className="out-body">{out.body}</div>
      {out.command && <span className="cmd">{out.command}</span>}
      <div className="out-note">{out.note}</div>
    </>
  );
}

interface OutState {
  /** What the chip says beside the ring. */
  chip: string;
  title: string;
  body: string;
  /** The one command that fixes it, or null when there is nothing to run. */
  command: string | null;
  note: string;
}

/**
 * The two statuses the reader can act on. `ok` and `unavailable` return null —
 * the first has gauges to draw, and the second has nothing worth saying.
 */
function outState(status: UsageStatus | undefined): OutState | null {
  if (status === 'signed-out') {
    return {
      chip: 'Signed out',
      title: 'Not signed in',
      body: 'The stored credential is there but blank, so the account usage endpoint has '
        + 'nothing to answer with: no name, no rate windows, no forecast. Sign in from a '
        + 'terminal — this board cannot do it for you.',
      command: 'claude auth login',
      note: 'The dashboard is read-only here: it can name the command, not run it.'
    };
  }
  if (status === 'token-expired') {
    return {
      chip: 'Token expired',
      title: 'Token expired',
      body: 'The stored OAuth token is past its expiry, so the usage endpoint refuses it. '
        + 'Nothing to do — it renews itself on one of the next polls and the gauges come back.',
      command: null,
      note: 'If it stays expired, the refresh token is gone too: sign in again from a terminal.'
    };
  }
  return null;
}

/** The avatar letter: the name's, else the email's, else nothing to letter. */
function initial(profile: AccountResponse['profile']): string {
  const source = profile?.name || profile?.email || '';
  return source ? source[0].toUpperCase() : '•';
}

/**
 * The empty ring that stands where the avatar does. Drawn in both the chip and
 * the popover, so it is one component rather than two copies of the path.
 */
function PersonRing({ large }: { large?: boolean }) {
  return (
    <span className={large ? 'ring lg' : 'ring'} aria-hidden="true">
      <svg viewBox="0 0 20 20">
        <circle cx="10" cy="7.4" r="3.1" />
        <path d="M4.4 16.2c.9-2.7 3.1-4.1 5.6-4.1s4.7 1.4 5.6 4.1" />
      </svg>
    </span>
  );
}

function Caret() {
  return (
    <svg className="cv" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 4l3 3 3-3" /></svg>
  );
}

/**
 * The rate-limit bars worth drawing — those with a utilization reading.
 * `short` is the chip's label, which has 52px for it; `label` is the popover's.
 */
export function usageBars(usage: UsageLimits | null | undefined) {
  if (!usage) return [];
  return [
    { label: '5h', short: '5H', rl: usage.fiveHour, windowMs: FIVE_HOUR_MS },
    { label: 'Week', short: 'WK', rl: usage.sevenDay, windowMs: SEVEN_DAY_MS }
  ].filter((b) => b.rl.utilization != null);
}

/** '' · mid · high — the ramp the fill, the figure and the strip all colour by. */
export type Level = '' | 'mid' | 'high';

const clampPct = (u: number): number => Math.max(0, Math.min(100, Math.round(u)));
const level = (pct: number): Level => (pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '');

function UsageBar({ label, rl, windowMs }: { label: string; rl: RateLimit; windowMs: number }) {
  const pct = clampPct(rl.utilization as number);
  const lvl = level(pct);
  const view = paceView(rl, windowMs);
  return (
    <div className="u">
      <div className="u-top">
        <span className="u-name">
          <span className="u-label">{label}:</span>
          <span className={`u-pct ${lvl}`.trim()}>{pct}%</span>
        </span>
        {rl.resetsAt && (
          <span className="u-reset">
            {view?.rateText ? `${view.rateText} · ` : ''}resets {formatResetTime(rl.resetsAt)}
          </span>
        )}
      </div>
      <div className="u-row">
        <div className="u-bar">
          <div className={`u-fill ${lvl}`.trim()} style={{ width: `${pct}%` }} />
        </div>
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
