/**
 * The 5-hour usage-limit alerts: *limit reached* when the window hits 100%, *limit reset* once a window that was pushed as reached is over.
 *
 * `decideUsageAlert` and `usageAlertCopy` are pure. `onUsageReading` is the shell the usage recorder calls: it re-reads the machine-wide ledger, decides,
 * writes the claim and only then sends. See `docs/subsystems/push-notify.md`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UsageLimits } from '../../shared/types.js';
import { readAccountProfile } from './account.js';
import type { Config } from './config.js';
import { sendUsageEvent, usageCanSend } from './notify.js';
import { getSettings } from './settings.js';
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

/* -------------------------------------------------- the I/O shell */

let armed: Config | null = null;
let fileOverride: string | null = null;
let homeOverride: string | null = null;
/** The last ledger this process decided on: the base when the file cannot be read, so a failed write still stops a repeat. */
let memory: UsageAlertLedger | null = null;
/** The last write failed: a missing file then means "never landed", not "deleted by hand", so memory stays the base. */
let writeFailed = false;

/** Called once from `server/index.ts` with the startup config, beside `startUsageRecording`; `null` disarms. */
export function armUsageAlerts(config: Config | null): void {
  armed = config;
}

/** Test seam: the ledger file. */
export function setUsageAlertsFile(file: string | null): void {
  fileOverride = file;
}

/** Test seam: the home `readAccountProfile` reads `.claude.json` from. */
export function setUsageAlertsHome(dir: string | null): void {
  homeOverride = dir;
}

/** Test seam: forget the in-memory ledger, as a restart (or a second process) would. */
export function resetUsageAlertsMemory(): void {
  memory = null;
  writeFailed = false;
}

/**
 * Machine-wide, not per checkout: a prod and a dev dashboard recording side by side must find each other's claim. Fixed under the home dir, deliberately
 * not under `SCHEDULES_STATE_ROOT`.
 */
function ledgerFile(): string {
  return fileOverride ?? path.join(os.homedir(), '.claude', 'dashboard', 'usage-alerts.json');
}

function readLedger(): UsageAlertLedger {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !writeFailed) return { windows: {} };
    return memory ?? { windows: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UsageAlertLedger> | null;
    if (parsed && typeof parsed.windows === 'object' && parsed.windows !== null) return { windows: parsed.windows };
  } catch {
    /* corrupt: fall through */
  }
  return memory ?? { windows: {} };
}

/** tmp + rename, so a reader never sees half a ledger. Returns false on failure; the caller sends anyway. */
function writeLedger(ledger: UsageAlertLedger): boolean {
  const file = ledgerFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ledger) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * One usage fetch. A no-op unless armed, `SHOW_USAGE` is on and Record usage history is on; `limits === null` is a failed fetch, which is no reading.
 * Never throws: it runs inside the recorder's tick.
 */
export function onUsageReading(limits: UsageLimits | null, now: number = Date.now()): void {
  try {
    const config = armed;
    if (!config || !config.showUsage || !getSettings().recordUsageHistory) return;
    const profile = readAccountProfile(homeOverride ?? undefined);
    if (!profile || profile.email === '') return;

    const reading: UsageReading = {
      t: now,
      account: profile.email,
      utilization: limits ? limits.fiveHour.utilization : null,
      resetsAt: limits ? limits.fiveHour.resetsAt : null,
      ok: limits !== null
    };
    const canSend = { reached: usageCanSend('reached', config), reset: usageCanSend('reset', config) };
    const before = readLedger();
    const { ledger, push } = decideUsageAlert(before, reading, canSend);
    memory = ledger;
    // Claim before send; a failed write keeps the claim in memory and still sends. Unchanged (no hit on record) → no write, so the file appears
    // only once a window has been hit.
    if (JSON.stringify(ledger) !== JSON.stringify(before)) writeFailed = !writeLedger(ledger);
    if (!push) return;

    const copy = usageAlertCopy(push, { resetsAt: reading.resetsAt, extraUsage: profile.extraUsage, now });
    sendUsageEvent({ kind: push === 'reached' ? 'usage-limit' : 'usage-reset', ...copy }, config);
  } catch {
    /* an alert must never break the usage fetch */
  }
}
