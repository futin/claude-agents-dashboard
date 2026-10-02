/**
 * The Git sub-view's fetch clock, client side: what the chip's two meters read, when to re-poll after a fetch is due or running, the Fetch all key's state and
 * the poll bookkeeping the hook delegates here. Pure — no React, no DOM — so every rule is a plain test. Words come from `gitStatsText.ts`; none is built here.
 *
 * The six interval values are a literal here and another in `server/lib/settings.ts`: no runtime constant crosses `shared/`, so each side pins its own list
 * with a test. The segment labels sit beside their values because the Settings card is their only reader.
 */
import type { FetchClock } from '../../../shared/types';
import { GIT_POLL_MS } from './gitPoll';
import {
  FETCH_NEEDS_TOKEN, FETCH_REFUSED, FETCH_START_FAILED, KEY_NOW, READ_FAILED, READ_FETCHING, READ_OFF, READ_OVERDUE, READ_PENDING, READ_SYNCING, fetchRowSub,
} from './gitStatsText';

export const GIT_FETCH_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 300, label: '5m' },
  { value: 600, label: '10m' },
];

/** How long after a fetch is due (or seen running) to ask the server again: long enough for it to have started, short enough to feel live. */
export const FETCH_FOLLOW_MS = 3_000;

export type MeterTone = 'green' | 'amber' | 'live';
export interface MeterReading {
  value: string;
  /** 0–1, how full the meter's bar is. */
  fraction: number;
  tone: MeterTone;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const PENDING: MeterReading = { value: READ_PENDING, fraction: 0, tone: 'green' };

/** The client clock's lead over the server's at the moment a payload arrived; adding it to a server-stamped time gives that time on the client's clock. Network latency is folded in. */
export function skewOf(generatedAt: number, receiptMs: number): number {
  return receiptMs - generatedAt;
}

/** Whole seconds rounded up (so the last second reads 1s, not 0s), then `m:ss` from a minute up. */
export function countdownText(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

/** First match wins: syncing, then failed, then no schedule yet, then the countdown to the next 30s poll. */
export function syncReading(s: { polling: boolean; error: boolean; nextPollAtMs: number | null; now: number }): MeterReading {
  if (s.polling) return { value: READ_SYNCING, fraction: 1, tone: 'live' };
  if (s.error) return { value: READ_FAILED, fraction: 1, tone: 'amber' };
  if (s.nextPollAtMs === null) return PENDING;
  const remaining = s.nextPollAtMs - s.now;
  return { value: countdownText(remaining), fraction: clamp01((GIT_POLL_MS - remaining) / GIT_POLL_MS), tone: 'green' };
}

/**
 * First match wins. A running fetch (the server's or this tab's own POST, which has not been answered yet) comes before everything, `off` included. An
 * undefined clock (an older server) and a null `nextAtMs` both read as pending: adding an interval to a null next time is how "overdue" would otherwise
 * show up on a clock that has simply not been scheduled yet.
 */
export function fetchReading(s: { clock: FetchClock | undefined; ownPost: boolean; skewMs: number; now: number }): MeterReading {
  const { clock } = s;
  if (s.ownPost || clock?.runningSinceMs != null) return { value: READ_FETCHING, fraction: 1, tone: 'live' };
  if (clock === undefined) return PENDING;
  if (clock.intervalSecs === 0) return { value: READ_OFF, fraction: 0, tone: 'amber' };
  if (clock.nextAtMs == null) return PENDING;
  const next = clock.nextAtMs + s.skewMs;
  const interval = clock.intervalSecs * 1000;
  if (s.now > next + interval) return { value: READ_OVERDUE, fraction: 1, tone: 'amber' };
  if (next <= s.now) return { value: countdownText(0), fraction: 1, tone: 'green' };
  return { value: countdownText(next - s.now), fraction: clamp01(1 - (next - s.now) / interval), tone: 'green' };
}

/**
 * When to poll `git-stats` again ahead of the 30s timer, or null. The key says *why*, so the hook can arm one follow-up per reason (`createFollowTracker`):
 * `run:` re-keys on every payload so a fetch that is still running keeps being watched, `due:` is stable per scheduled time so one due fetch is chased once.
 */
export function followUp(s: { clock: FetchClock | undefined; generatedAt: number; skewMs: number; now: number; visible: boolean }): { key: string; delayMs: number } | null {
  const { clock } = s;
  if (!s.visible || clock === undefined) return null;
  if (clock.runningSinceMs != null) return { key: `run:${clock.runningSinceMs}:${s.generatedAt}`, delayMs: FETCH_FOLLOW_MS };
  if (clock.intervalSecs > 0 && clock.nextAtMs != null && clock.nextAtMs + s.skewMs <= s.now) return { key: `due:${clock.nextAtMs}`, delayMs: FETCH_FOLLOW_MS };
  return null;
}

/**
 * True the first time a key is seen under its prefix (`due:` / `run:`), false until a different key of that prefix arrives. Without the memory, hiding and
 * showing the page re-runs the effect and re-fires the same `due:` follow-up.
 */
export function createFollowTracker(): { arm(key: string): boolean } {
  const last = new Map<string, string>();
  return {
    arm(key) {
      const prefix = key.slice(0, key.indexOf(':'));
      if (last.get(prefix) === key) return false;
      last.set(prefix, key);
      return true;
    },
  };
}

/** The hook's in-flight bookkeeping: one poll runs, one more waits, the rest are redundant with the one that waits. */
export function createPollGate(): { request(): 'run' | 'queued' | 'dropped'; end(): boolean } {
  let inFlight = false;
  let queued = false;
  return {
    request() {
      if (!inFlight) { inFlight = true; return 'run'; }
      if (queued) return 'dropped';
      queued = true;
      return 'queued';
    },
    end() {
      inFlight = false;
      const start = queued;
      queued = false;
      return start;
    },
  };
}

/** A 403 is the server saying the Answer token is wrong; any other status, or no answer at all, is a launch that did not happen. */
export function fetchFailureOf(status: number | 'network'): 'refused' | 'failed' {
  return status === 403 ? 'refused' : 'failed';
}

/**
 * The Fetch all key. No stored token on a server that wants one outranks everything (nothing was sent, so nothing can have been refused); an undefined
 * `tokenRequired` means health has not answered, and the key stays usable. `intervalSecs` is undefined before any payload or on an older server, which has no
 * auto-fetch to be off — so the sub is the bare command and never amber.
 */
export function fetchKeyState(s: {
  tokenRequired: boolean | undefined; tokenStored: boolean; failure: 'refused' | 'failed' | null; pending: boolean; running: boolean; intervalSecs: number | undefined;
}): { disabled: boolean; label: string; sub: string; subTone: 'amber' | null } {
  const offTone = s.intervalSecs === 0 ? 'amber' : null;
  if (s.tokenRequired === true && !s.tokenStored) return { disabled: true, label: KEY_NOW, sub: FETCH_NEEDS_TOKEN, subTone: 'amber' };
  if (s.failure === 'refused') return { disabled: true, label: KEY_NOW, sub: FETCH_REFUSED, subTone: 'amber' };
  if (s.running || s.pending) return { disabled: true, label: READ_FETCHING, sub: fetchRowSub(s.intervalSecs), subTone: offTone };
  if (s.failure === 'failed') return { disabled: false, label: KEY_NOW, sub: FETCH_START_FAILED, subTone: 'amber' };
  return { disabled: false, label: KEY_NOW, sub: fetchRowSub(s.intervalSecs), subTone: offTone };
}
