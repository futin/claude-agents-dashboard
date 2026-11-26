/**
 * idle.ts — the "are they back at the desk?" policy shared by every held wait.
 *
 * A hold opens because you walked away, so walking back should close it: the
 * hook stops waiting on the dashboard and the terminal's own dialog (question
 * card, plan card, or just the turn ending) takes over within ~5s. All three
 * stores — `pending.ts`, `plans.ts`, `messages.ts` — need the exact same
 * verdict, so it lives here rather than three times over. It first lived only
 * in `messages.ts`, which is precisely why held questions and plans sat parked
 * until their deadlines.
 *
 * The stores keep their own `sweepIdle()`: what is releasable (headless holds
 * are exempt in `messages.ts`) and what status it settles as are per-store, but
 * the reading and the fail directions are not.
 *
 * See `docs/subsystems/remote-answer.md`.
 */

import { execFile } from 'node:child_process';

import { getSettings } from './settings.js';

/**
 * Seconds since the last keyboard/mouse event, or null when unreadable.
 *
 * Same source `ask-remote-hook.sh` uses. Unreadable means non-macOS or a
 * container, and the predicate treats that as "push anyway" — see
 * `shouldNotify` in `notify.ts`.
 *
 * Async so the ~30–40 ms `ioreg` run never blocks the loop (spec `2026-11-14-poll-path-probes-design.md` A1). Never rejects.
 */
export function readIdleSecs(): Promise<number | null> {
  return new Promise(resolve => {
    try {
      execFile('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8', timeout: 1000 }, (err, out) => {
        resolve(err ? null : parseIdleSecs(out));
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Whole seconds of keyboard idle from `ioreg -c IOHIDSystem` output: its `HIDIdleTime` is nanoseconds, floored to the second. null when the output carries
 * no such line — the same "unreadable" {@link readIdleSecs} reports for a failed run.
 */
export function parseIdleSecs(out: string): number | null {
  const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return match ? Math.floor(Number(match[1]) / 1_000_000_000) : null;
}

/** What an idle source answers: a reading, sync or async — test fakes stay synchronous, the real reader is not. */
export type IdleReading = number | null | Promise<number | null>;

/**
 * Are they at the keyboard right now? Pure — the reading is the caller's to make.
 *
 * Three callers, one rule: `backAtDesk()` (`idle.ts`) releases held waits on it,
 * `shouldNotify`'s `requireAfk` clause suppresses a push on its inverse, and
 * `maybeSend` routes to the desk topic on it. It lived inline in the first two
 * and the third would have been a third copy.
 *
 * `thresholdSecs === 0` is false, not "always at the desk": zero disables the
 * idle gate everywhere else in the app, so it disables these too. A null reading
 * is false for the same reason `backAtDesk` fails that way — never decide from a
 * guess.
 */
export function atDesk(idleSecs: number | null, thresholdSecs: number): boolean {
  if (thresholdSecs === 0) return false;
  return idleSecs !== null && idleSecs < thresholdSecs;
}

let idleReader: (() => IdleReading) | null = null;

/**
 * Test seam: swap the idle source so no test spawns `ioreg`. `null` restores
 * the real reader. Shared by every store's `sweepIdle` tests.
 */
export function setIdleReader(fn: (() => IdleReading) | null): void {
  idleReader = fn;
}

/**
 * True only when a real reading says the user is at the keyboard right now.
 *
 * Fail directions, both deliberately "stay held":
 *  - unreadable idle (Docker, non-macOS) → false. Never end a wait on a guess;
 *    the deadline timer is the reaper of last resort. Same direction
 *    `ask-remote-hook.sh` takes for the same reason.
 *  - `idleSecs === 0` → false. Zero disables the idle gate everywhere else
 *    (the hooks skip the check entirely), so it disables auto-release too.
 *
 * ⚠️ Spawns `ioreg` (~40ms, off the loop). Callers check they have something
 * releasable *before* asking, so an idle server never pays for it.
 */
export async function backAtDesk(): Promise<boolean> {
  const thresholdSecs = getSettings().idleSecs;
  // Checked before the read, not inside `atDesk`: the reading costs an `ioreg`
  // spawn and a zero threshold makes the answer false regardless, so asking
  // would be ~40ms spent on a foregone conclusion. `atDesk` re-checks it anyway
  // for callers that already hold a reading.
  if (thresholdSecs === 0) return false;
  return atDesk(await (idleReader ?? readIdleSecs)(), thresholdSecs);
}
