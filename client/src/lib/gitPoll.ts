/**
 * The Git sub-view's poll schedule (spec §6 Polling), apart from React and the DOM so it can be tested with fake timers. `useGitStats` hands it the real
 * `document` and `window` pieces; a test hands it counters.
 *
 * - one poll on start, whatever the visibility (the view was just opened, so its data is wanted now)
 * - a 30s timer that runs only while the page is visible
 * - going visible polls at once and restarts the timer, so the next poll is a full interval later; going hidden drops the timer
 * - the returned stop function unsubscribes and drops the timer, so nothing fires after the view unmounts
 */
export const GIT_POLL_MS = 30_000;

export interface GitPollDeps {
  poll(): void;
  isVisible(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange(cb: () => void): () => void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  /** The clock `onSchedule` is told times of; defaults to `Date.now`. */
  now?(): number;
  /** When the next timed poll is due (epoch ms), or null once the timer is dropped — so the chip's SYNC countdown reads the real schedule. */
  onSchedule?(nextAtMs: number | null): void;
}

export function startGitPoll(d: GitPollDeps): () => void {
  let timer: unknown = null;
  const now = d.now ?? Date.now;
  // The timer repeats, so the schedule is re-reported on every fire: reported only at arm time it would go stale after the first one.
  const arm = () => {
    if (timer !== null) return;
    d.onSchedule?.(now() + GIT_POLL_MS);
    timer = d.setTimer(() => { d.onSchedule?.(now() + GIT_POLL_MS); d.poll(); }, GIT_POLL_MS);
  };
  // `disarm` runs on every visibility change and on stop, so it only says "no schedule" when it actually cleared one.
  const disarm = () => {
    if (timer === null) return;
    d.clearTimer(timer);
    timer = null;
    d.onSchedule?.(null);
  };

  d.poll();
  if (d.isVisible()) arm();
  const off = d.onVisibilityChange(() => {
    disarm();
    if (d.isVisible()) { d.poll(); arm(); }
  });
  return () => { off(); disarm(); };
}
