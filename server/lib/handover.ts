/**
 * handover.ts — a desktop launch runs its first turn headless here, then moves to the desktop app.
 *
 * The app's `claude://code/new` link cannot start work unattended: on app 4.4212.0 it puts the prompt in the composer as a draft, behind the app's own
 * per-folder "Trust this workspace?" prompt (measured 2026-10-30, `~/Library/Logs/Claude/main.log`). So `surface: 'desktop'` launches an ordinary
 * one-shot `claude -p` and this module watches its transcript. Once the first turn has ended cleanly it fires `claude://resume?session=<id>`, which the
 * app imports with no trust prompt. The child is left to its post-turn linger, where a second writer is benign (`docs/subsystems/spawn.md` §Two writers).
 *
 * The watch lives in memory: a server restart drops it, and the session then stays a dashboard one, which the chat drawer can still hand over by hand.
 */

import { openDesktopUrl, releaseDesktopLaunch, reserveDesktopLaunch, resumeUrl } from './desktop.js';
import { findTranscript, projectsRoot } from './scan.js';
import { launchEntryState } from './spawn.js';
import { readTranscript } from './transcript.js';

/** The scan's own cadence: a turn end is seen at most this late, plus one settle poll. */
export const HANDOVER_POLL_MS = 3000;
/** A first turn still running after this long is left in the dashboard rather than watched forever. */
export const HANDOVER_MAX_MS = 2 * 60 * 60_000;

/** One watched launch. `settledMtimeMs` is the transcript's mtime on the poll that first saw the turn end. */
export interface HandOverWatch {
  id: string;
  startedAtMs: number;
  settledMtimeMs: number | null;
}

export type HandOverStep = 'wait' | 'handed-over' | 'gave-up';

/**
 * One poll of `w`. Hands over only when two polls in a row see the same finished transcript: a Stop hook that blocks the stop starts another turn right
 * after the `end_turn` record, and firing the link then would put the app's writer on a transcript mid-turn, which forks it.
 */
export async function stepHandOver(w: HandOverWatch, now: number = Date.now()): Promise<HandOverStep> {
  if (now - w.startedAtMs > HANDOVER_MAX_MS) return 'gave-up';
  // Read the store before the transcript: a child gone by now wrote its last record before it went, so the read below cannot miss it.
  const state = launchEntryState(w.id);
  if (state === 'failed') return 'gave-up';
  const t = findTranscript(projectsRoot(), w.id);
  const tr = t ? readTranscript(t.file) : null;
  if (!t || !tr?.hasMessages || !tr.turnComplete) {
    w.settledMtimeMs = null;
    // Gone without a finished turn: stopped from the dashboard, or crashed. It stays a dashboard session.
    return state === null ? 'gave-up' : 'wait';
  }
  if (w.settledMtimeMs !== t.mtimeMs) {
    w.settledMtimeMs = t.mtimeMs;
    return 'wait';
  }
  const slot = reserveDesktopLaunch(w.id, now);
  // `in-flight`: someone pressed the chat drawer's hand-over in the meantime, and that one is already on its way.
  if (slot.status !== 'ok') return slot.status === 'rail-full' ? 'wait' : 'gave-up';
  try {
    await openDesktopUrl(resumeUrl(w.id));
  } catch (e) {
    releaseDesktopLaunch(w.id, slot.at);
    console.error('[dashboard] desktop hand-over failed:', (e as Error).message);
    return 'gave-up';
  }
  return 'handed-over';
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Start watching a desktop launch. A second call for the same id is a no-op. The timer is unref'd, so a watch never holds the process open. */
export function watchHandOver(id: string, now: number = Date.now()): void {
  if (timers.has(id)) return;
  const w: HandOverWatch = { id, startedAtMs: now, settledMtimeMs: null };
  const schedule = (): void => {
    const timer = setTimeout(() => {
      stepHandOver(w).then(
        step => { if (step === 'wait' && timers.has(id)) schedule(); else timers.delete(id); },
        e => { timers.delete(id); console.error('[dashboard] desktop hand-over watch failed:', (e as Error).message); }
      );
    }, HANDOVER_POLL_MS);
    timer.unref();
    timers.set(id, timer);
  };
  schedule();
}

/** Ids being watched, for tests. */
export function watchedHandOvers(): string[] {
  return [...timers.keys()];
}

/** Test seam: drop every watch. */
export function resetHandOvers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
