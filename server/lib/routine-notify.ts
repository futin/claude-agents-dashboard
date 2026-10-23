/**
 * routine-notify.ts — turns folded routine runs into at most one `routine-failed` push each. `pushableEvents` (routine-log.ts) says what qualifies and
 * with what copy; `sendRoutineEvent` (notify.ts) owns the policy and the transport. What lives here is the "seen" ledger: an in-memory id set backed by
 * `<state>/notified.json`, so a restart does not resend and a run pushed as lost that later ends failed does not push twice (the run id is the key).
 *
 * The caller (the server's fold, on `fs.watch` of `runs/`, on every poll and on start) hands over whatever it folded; only the owning server sends, so a
 * second dashboard on the same machine cannot double-push.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { RoutineRun } from '../../shared/types.js';
import type { Config } from './config.js';
import { sendRoutineEvent } from './notify.js';
import { routineStateRoot } from './routine-config.js';
import { pushableEvents } from './routine-log.js';
import { isOwner } from './routine-store.js';

/** Only a run whose end (or, lost or refused, whose start) falls inside this window can push; the ledger is pruned by the same age, so it always covers
 * every run the fold can offer. The fold itself has no window: rotation keeps every log file, so it hands over the whole history. */
export const PUSH_HORIZON_MS = 7 * 24 * 3600_000;

/** Backstop only. Past it the oldest ids are dropped and `floor` rises to the newest dropped stamp, so nothing at or before it pushes again. */
const MAX_IDS = 2000;

type Pushable = ReturnType<typeof pushableEvents>[number];

/** id -> the run's event time (ms) when last sighted; `floor` is the newest stamp the backstop dropped (0 = none). */
interface Ledger { file: string; seen: Map<string, number>; floor: number }

let loaded: Ledger | null = null;

/** Test seam: forget the in-memory set so the next call rereads `notified.json`. */
export function resetRoutineNotify(): void {
  loaded = null;
}

/** The time a pushable run's age is measured from; NaN when the log carries no usable time. */
function eventAt(run: RoutineRun): number {
  return Date.parse(run.endedAt ?? run.startedAt);
}

function ledger(config: Config, now: number): Ledger {
  const file = path.join(routineStateRoot(config), 'notified.json');
  if (loaded && loaded.file === file) return loaded;
  const seen = new Map<string, number>();
  let floor = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The first shape was a plain id list, `{ids: [...]}`: stamped now, each id outlives the horizon of any run it could name.
    const legacy: unknown = Array.isArray(raw) ? raw : raw?.ids;
    if (Array.isArray(legacy)) {
      for (const id of legacy) if (typeof id === 'string') seen.set(id, now);
    } else if (raw && typeof raw.seen === 'object' && raw.seen !== null) {
      for (const [id, at] of Object.entries(raw.seen)) if (typeof at === 'number' && Number.isFinite(at)) seen.set(id, at);
      if (typeof raw.floor === 'number' && Number.isFinite(raw.floor)) floor = raw.floor;
    }
  } catch {
    /* absent or unreadable: start empty — an old failure may repeat once, which beats a lost one */
  }
  loaded = { file, seen, floor };
  return loaded;
}

function prune(l: Ledger, now: number): void {
  for (const [id, at] of l.seen) if (now - at > PUSH_HORIZON_MS) l.seen.delete(id);
  if (l.seen.size <= MAX_IDS) return;
  const byAge = [...l.seen].sort((a, b) => a[1] - b[1]);
  for (const [id, at] of byAge.slice(0, byAge.length - MAX_IDS)) {
    l.seen.delete(id);
    l.floor = Math.max(l.floor, at);
  }
}

function persist(l: Ledger, now: number): void {
  prune(l, now);
  try {
    fs.mkdirSync(path.dirname(l.file), { recursive: true });
    const tmp = `${l.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l.floor > 0 ? { seen: Object.fromEntries(l.seen), floor: l.floor } : { seen: Object.fromEntries(l.seen) }));
    fs.renameSync(tmp, l.file);
  } catch {
    /* the in-memory set still dedupes this process; only a restart could resend */
  }
}

/** Qualifying runs inside the horizon and past the backstop floor, each with its event time. */
function inHorizon(l: Ledger, runs: RoutineRun[], now: number): Array<{ e: Pushable; at: number }> {
  const out: Array<{ e: Pushable; at: number }> = [];
  for (const e of pushableEvents(runs)) {
    const at = eventAt(e.run);
    if (Number.isFinite(at) && now - at <= PUSH_HORIZON_MS && at > l.floor) out.push({ e, at });
  }
  return out;
}

/**
 * Push each qualifying run not seen before and remember it. A run is marked seen when first sighted even if the policy then declines it (master off, no
 * topic, a user-stopped run), so enabling the switch later does not flood old failures. Only runs inside {@link PUSH_HORIZON_MS} qualify. Returns how many
 * pushes were handed to the transport.
 */
export function notifyRoutineRuns(config: Config, runs: RoutineRun[], send: typeof sendRoutineEvent = sendRoutineEvent, now: number = Date.now()): number {
  if (!isOwner()) return 0;
  const l = ledger(config, now);
  let sent = 0;
  let changed = false;
  for (const { e, at } of inHorizon(l, runs, now)) {
    const prev = l.seen.get(e.run.id);
    if (prev !== undefined) {
      // A lost run that later ends moves its stamp forward, so the entry outlives the run's new age.
      if (at > prev) { l.seen.set(e.run.id, at); changed = true; }
      continue;
    }
    l.seen.set(e.run.id, at);
    changed = true;
    // A Stop press or a SIGTERM is the user's own doing; the run still counts as seen.
    if (e.run.stopped) continue;
    if (send(e, config)) sent++;
  }
  if (changed) persist(l, now);
  return sent;
}

/** How old a run must be for the first-ever start to file it as seen instead of pushing it. */
export const SEED_AGE_MS = 24 * 3600_000;

/**
 * First-ever start only (no `notified.json` yet): mark every qualifying run inside the horizon that started over {@link SEED_AGE_MS} ago seen without pushing it, so a machine that
 * has been logging runs before its server took ownership does not push its whole history at once. The newer ones are left for the fold to push. Writes
 * `notified.json` even when nothing qualified, which is what makes the next start not a first one. Returns how many runs were seeded.
 */
export function seedRoutineNotify(config: Config, runs: RoutineRun[], now: number = Date.now()): number {
  if (!isOwner()) return 0;
  const file = path.join(routineStateRoot(config), 'notified.json');
  if (fs.existsSync(file)) return 0;
  const l = ledger(config, now);
  let seeded = 0;
  for (const { e, at } of inHorizon(l, runs, now)) {
    const started = Date.parse(e.run.startedAt);
    if (!Number.isFinite(started) || now - started <= SEED_AGE_MS || l.seen.has(e.run.id)) continue;
    l.seen.set(e.run.id, at);
    seeded++;
  }
  persist(l, now);
  return seeded;
}
