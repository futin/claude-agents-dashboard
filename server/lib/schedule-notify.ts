/**
 * schedule-notify.ts — turns folded schedule runs into at most one `schedule-failed` push each. `pushableEvents` (schedule-log.ts) says what qualifies and
 * with what copy; `sendScheduleEvent` (notify.ts) owns the policy and the transport. What lives here is the "seen" ledger: an in-memory id set backed by
 * `<state>/notified.json`, so a restart does not resend and a run pushed as lost that later ends failed does not push twice (the run id is the key).
 *
 * The caller (the server's fold, on `fs.watch` of `runs/`, on every poll and on start) hands over whatever it folded; only the owning server sends, so a
 * second dashboard on the same machine cannot double-push.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ScheduleRun } from '../../shared/types.js';
import type { Config } from './config.js';
import { sendScheduleEvent } from './notify.js';
import { scheduleStateRoot } from './schedule-config.js';
import { pushableEvents } from './schedule-log.js';
import { isOwner } from './schedule-store.js';

/** Old enough ids fall out; a run that old is no longer in the log window the fold reads, so it cannot come back to be pushed. */
const MAX_IDS = 2000;

let loaded: { file: string; ids: Set<string> } | null = null;

/** Test seam: forget the in-memory set so the next call rereads `notified.json`. */
export function resetScheduleNotify(): void {
  loaded = null;
}

function ledger(config: Config): { file: string; ids: Set<string> } {
  const file = path.join(scheduleStateRoot(config), 'notified.json');
  if (loaded && loaded.file === file) return loaded;
  let ids = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.ids)) ids = new Set(raw.ids.filter((x: unknown): x is string => typeof x === 'string'));
  } catch {
    /* absent or unreadable: start empty — an old failure may repeat once, which beats a lost one */
  }
  loaded = { file, ids };
  return loaded;
}

function persist(l: { file: string; ids: Set<string> }): void {
  try {
    const ids = [...l.ids].slice(-MAX_IDS);
    fs.mkdirSync(path.dirname(l.file), { recursive: true });
    const tmp = `${l.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids }));
    fs.renameSync(tmp, l.file);
  } catch {
    /* the in-memory set still dedupes this process; only a restart could resend */
  }
}

/**
 * Push each qualifying run not seen before and remember it. A run is marked seen when first sighted even if the policy then declines it (master off, no
 * topic, a user-stopped run), so enabling the switch later does not flood old failures. Returns how many pushes were handed to the transport.
 */
export function notifyScheduleRuns(config: Config, runs: ScheduleRun[], send: typeof sendScheduleEvent = sendScheduleEvent): number {
  if (!isOwner()) return 0;
  const l = ledger(config);
  let sent = 0;
  let changed = false;
  for (const e of pushableEvents(runs)) {
    if (l.ids.has(e.run.id)) continue;
    l.ids.add(e.run.id);
    changed = true;
    // A Stop press or a SIGTERM is the user's own doing; the run still counts as seen.
    if (e.run.stopped) continue;
    if (send(e, config)) sent++;
  }
  if (changed) persist(l);
  return sent;
}

/** How old a run must be for the first-ever start to file it as seen instead of pushing it. */
export const SEED_AGE_MS = 24 * 3600_000;

/**
 * First-ever start only (no `notified.json` yet): mark every qualifying run older than {@link SEED_AGE_MS} seen without pushing it, so a machine that
 * has been logging runs before its server took ownership does not push its whole history at once. The newer ones are left for the fold to push. Writes
 * `notified.json` even when nothing qualified, which is what makes the next start not a first one. Returns how many runs were seeded.
 */
export function seedScheduleNotify(config: Config, runs: ScheduleRun[], now: number = Date.now()): number {
  if (!isOwner()) return 0;
  const file = path.join(scheduleStateRoot(config), 'notified.json');
  if (fs.existsSync(file)) return 0;
  const l = ledger(config);
  let seeded = 0;
  for (const e of pushableEvents(runs)) {
    const at = Date.parse(e.run.startedAt);
    if (!Number.isFinite(at) || now - at <= SEED_AGE_MS || l.ids.has(e.run.id)) continue;
    l.ids.add(e.run.id);
    seeded++;
  }
  persist(l);
  return seeded;
}
