/**
 * The 5-hour usage-limit alerts: *limit reached* when the window hits 100%, *limit reset* once a window that was pushed as reached is over.
 *
 * This file holds the pure decision and the push copy. It reads nothing and sends nothing; see `docs/subsystems/push-notify.md`.
 */
import { sameWindow } from './usage-history.js';

/** One usage fetch, reduced to what the detector judges. */
export interface UsageReading {
  /** Reading time, ms epoch. */
  t: number;
  /** Account email; `''` when no profile could be read, which makes this not a reading. */
  account: string;
  utilization: number | null;
  resetsAt: string | null;
  /** The fetch succeeded. A failed one is "no reading", never 0%. */
  ok: boolean;
}

/** The one window on record for an account. */
export interface UsageAlertRecord {
  account: string;
  /** The `resetsAt` first seen at the hit; later readings of the same window jitter around it by under a second. */
  stamp: string | null;
  hitT: number;
  /** Whether *reached* actually went out. A hit seen with the checkbox off is recorded but never earns a reset. */
  pushed: boolean;
  resetSent: boolean;
  lastSeenT: number;
}

export interface UsageAlertLedger {
  /** Keyed by account email. Holds at most one record in practice: an account switch deletes the other. */
  windows: Record<string, UsageAlertRecord>;
}

export type UsageAlertKind = 'reached' | 'reset';

/** A reset seen more than this after it happened (server down, recording off) is retired without a push. */
export const RESET_STALE_MS = 60 * 60_000;

/**
 * Judges one reading against the ledger. Pure: returns a new ledger and the push to send, if any. `canSend` says whether each push would go out now; a
 * reached hit that could not be sent is still recorded, so switching the checkbox on mid-window pushes neither it nor its reset.
 */
export function decideUsageAlert(
  ledger: UsageAlertLedger,
  reading: UsageReading,
  canSend: Record<UsageAlertKind, boolean>
): { ledger: UsageAlertLedger; push: UsageAlertKind | null } {
  const { t, account, utilization } = reading;
  if (!reading.ok || utilization === null || account === '') return { ledger, push: null };

  // Account switch first: a pending reset belongs to the account that hit, and returning to it later must not fire a stale one.
  const windows: Record<string, UsageAlertRecord> = {};
  const rec = ledger.windows[account];
  if (rec) windows[account] = rec;
  const same = (push: UsageAlertKind | null = null) => ({ ledger: { windows }, push });

  if (rec && t < rec.lastSeenT) return same(); // a late reading from an abandoned fetch cycle

  if (utilization >= 100) {
    if (rec && sameWindow(rec.stamp, reading.resetsAt)) {
      windows[account] = { ...rec, lastSeenT: t };
      return same();
    }
    windows[account] = { account, stamp: reading.resetsAt, hitT: t, pushed: canSend.reached, resetSent: false, lastSeenT: t };
    return same(canSend.reached ? 'reached' : null);
  }

  if (!rec) return same();
  if (rec.resetSent) {
    windows[account] = { ...rec, lastSeenT: t };
    return same();
  }
  const stampMs = rec.stamp === null ? NaN : Date.parse(rec.stamp);
  const over = rec.stamp === null || !sameWindow(rec.stamp, reading.resetsAt) || stampMs <= t;
  if (!over) {
    windows[account] = { ...rec, lastSeenT: t };
    return same();
  }
  // Unscoped hits have no reset time to measure from; the gap since the window was last seen at 100% stands in for it.
  const stale = rec.stamp === null ? t - rec.lastSeenT > RESET_STALE_MS : t - stampMs > RESET_STALE_MS;
  windows[account] = { ...rec, resetSent: true, lastSeenT: t };
  return same(rec.pushed && canSend.reset && !stale ? 'reset' : null);
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** When the window resets, in the server's local zone: `Resets at 14:30.` today, `Resets Tue at 09:10.` on another day. */
function resetPhrase(resetsAt: string | null, now: number): string {
  const ms = resetsAt === null ? NaN : Date.parse(resetsAt);
  if (Number.isNaN(ms)) return 'No reset time reported.';
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `Resets at ${hhmm}.` : `Resets ${WEEKDAY[d.getDay()]} at ${hhmm}.`;
}

/** The push's title and body. */
export function usageAlertCopy(
  kind: UsageAlertKind,
  o: { resetsAt: string | null; extraUsage: boolean; now: number }
): { title: string; body: string } {
  if (kind === 'reached') {
    const billed = o.extraUsage ? ' Extra usage is on: you are now billed.' : '';
    return { title: '5-hour limit reached', body: resetPhrase(o.resetsAt, o.now) + billed };
  }
  return {
    title: '5-hour limit reset',
    body: o.extraUsage ? 'Back on plan usage: extra-usage billing stops.' : 'Usage is available again.'
  };
}
