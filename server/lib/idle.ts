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

import { readIdleSecs } from './notify.js';
import { getSettings } from './settings.js';

let idleReader: (() => number | null) | null = null;

/**
 * Test seam: swap the idle source so no test spawns `ioreg`. `null` restores
 * the real reader. Shared by every store's `sweepIdle` tests.
 */
export function setIdleReader(fn: (() => number | null) | null): void {
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
 * ⚠️ Spawns `ioreg` (~40ms). Callers check they have something releasable
 * *before* asking, so an idle server never pays for it.
 */
export function backAtDesk(): boolean {
  const thresholdSecs = getSettings().idleSecs;
  if (thresholdSecs === 0) return false;
  const idle = (idleReader ?? readIdleSecs)();
  return idle !== null && idle < thresholdSecs;
}
