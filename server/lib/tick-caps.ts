/**
 * The `tick-capped` push: one push when a backlog-tick job stops grooming because its project's plans awaiting review reached the cap, and none again until
 * that project has dropped below the cap and reached it once more.
 *
 * `decideTickCapped` and `tickCappedCopy` are pure. `readTickReadings` reads each project's `last-decide.json`, which backlog-manager's `tick.mjs` writes
 * and nothing here ever does. `foldTickCaps` is the shell the routine push fold calls. See `docs/subsystems/push-notify.md`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from './config.js';
import { sendTickCappedEvent, tickCanSend } from './notify.js';
import { routineStateRoot } from './routine-config.js';
import { isOwner } from './routine-store.js';

/** One project's last `decide`, reduced to what the detector judges. */
export interface TickReading {
  /** The project's main checkout, decoded from its tick directory's name. */
  root: string;
  /** `basename(root)`, for the push's title. */
  name: string;
  /** When `decide` ran, ISO. */
  at: string;
  planReview: number;
  maxPlans: number;
}

/** One capped episode on record. */
export interface TickCapEntry {
  /** The reading's `at` when the episode was first seen. */
  cappedAt: string;
  /** Whether the push actually went out. An episode seen with the checkbox off is recorded unpushed and stays that way. */
  pushed: boolean;
}

export interface TickCapLedger {
  /** Keyed by project root. An entry exists only while that project is capped. */
  projects: Record<string, TickCapEntry>;
}

export interface TickCapPush {
  root: string;
  title: string;
  body: string;
}

/** A capped reading older than this (the server's first start, a disabled job) is recorded without a push. */
export const TICK_FRESH_MS = 24 * 60 * 60_000;

/** The push's title and body. */
export function tickCappedCopy(r: TickReading): { title: string; body: string } {
  return { title: `${r.name} · backlog tick blocked`, body: `${r.planReview}/${r.maxPlans} plans awaiting review — approve one to resume grooming` };
}

/**
 * Judges every project's reading against the ledger. Pure: returns a new ledger and the pushes to send. A `--max-plans 0` job never grooms by choice, so
 * `maxPlans 0` is never capped.
 */
export function decideTickCapped(
  ledger: TickCapLedger,
  readings: TickReading[],
  canSend: boolean,
  now: number
): { ledger: TickCapLedger; pushes: TickCapPush[] } {
  // Built from the readings alone, so an entry whose project has no reading (its tick dir is gone) drops out.
  const projects: Record<string, TickCapEntry> = {};
  const pushes: TickCapPush[] = [];
  for (const r of readings) {
    if (!(r.maxPlans > 0 && r.planReview >= r.maxPlans)) continue; // not capped: no entry, so the next cap pushes again
    const rec = ledger.projects[r.root];
    if (rec) {
      projects[r.root] = rec;
      continue;
    }
    const send = canSend && now - Date.parse(r.at) <= TICK_FRESH_MS;
    projects[r.root] = { cappedAt: r.at, pushed: send };
    if (send) pushes.push({ root: r.root, ...tickCappedCopy(r) });
  }
  return { ledger: { projects }, pushes };
}

/* -------------------------------------------------- the reader */

let homeOverride: string | null = null;

/** Test seam: the tick home. */
export function setTickHome(dir: string | null): void {
  homeOverride = dir;
}

/** Hand twin of backlog-manager's `tickHome()` (`skills/backlog-tick/tools/tick-lib.mjs`): change one, change the other. */
function tickHome(): string {
  return homeOverride ?? (process.env.BM_TICK_HOME || path.join(os.homedir(), '.backlog-manager', 'tick'));
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Every project's last `decide`, validated the way backlog-manager's `readLastDecide` (`server/src/tick/tick.service.ts`) does. A missing home, a missing
 * file or a malformed one skips that project; nothing here throws.
 */
export function readTickReadings(home: string = tickHome()): TickReading[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(home);
  } catch {
    return [];
  }
  const out: TickReading[] = [];
  for (const dir of dirs) {
    try {
      const root = decodeURIComponent(dir); // `tick.mjs` names each dir `encodeURIComponent(root)`
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(home, dir, 'last-decide.json'), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const { at, caps } = raw as { at?: unknown; caps?: unknown };
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !caps || typeof caps !== 'object') continue;
      const { planReview, maxPlans } = caps as { planReview?: unknown; maxPlans?: unknown };
      if (!isCount(planReview) || !isCount(maxPlans)) continue;
      out.push({ root, name: path.basename(root), at, planReview, maxPlans });
    } catch {
      /* undecodable name, no file, not JSON: skip this project */
    }
  }
  return out;
}

/* -------------------------------------------------- the I/O shell */

let fileOverride: string | null = null;
let ownerOverride: (() => boolean) | null = null;
/** The last ledger this process decided on: the base when the file cannot be read, so a failed write still stops a repeat. */
let memory: TickCapLedger | null = null;
/** The last write failed: a missing file then means "never landed", not "deleted by hand", so memory stays the base. */
let writeFailed = false;
/** What every `last-decide.json` looked like at the last pass; a pass with nothing changed since cannot push, so it is skipped. */
let lastSeen: string | null = null;

/** Test seam: the ledger file. */
export function setTickCapsFile(file: string | null): void {
  fileOverride = file;
}

/** Test seam: whether this server owns routines. `null` restores `isOwner`. */
export function setTickCapsOwner(fn: (() => boolean) | null): void {
  ownerOverride = fn;
}

/** Test seam: forget the in-memory ledger and the last pass's file stats, as a restart would. */
export function resetTickCapsMemory(): void {
  memory = null;
  writeFailed = false;
  lastSeen = null;
}

function ledgerFile(config: Config): string {
  return fileOverride ?? path.join(routineStateRoot(config), 'tick-capped.json');
}

function readLedger(file: string): TickCapLedger {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !writeFailed) return { projects: {} };
    return memory ?? { projects: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TickCapLedger> | null;
    if (parsed && typeof parsed.projects === 'object' && parsed.projects !== null) return { projects: parsed.projects };
  } catch {
    /* corrupt: fall through */
  }
  return memory ?? { projects: {} };
}

/**
 * Every `last-decide.json`'s identity, mtime and size, one stat each. A clock throttle would drop the pass at the end of the very run that hits the cap,
 * which comes seconds after the pass at its start; this skips only a pass that has nothing new to read.
 */
function decideStats(home: string): string {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(home);
  } catch {
    return '';
  }
  const out: string[] = [];
  for (const dir of dirs.sort()) {
    try {
      const st = fs.statSync(path.join(home, dir, 'last-decide.json'));
      out.push(`${dir}:${st.ino}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* no file: nothing to read */
    }
  }
  return out.join('\n');
}

/** tmp + rename, so a reader never sees half a ledger. Returns false on failure; the caller sends anyway. */
function writeLedger(file: string, ledger: TickCapLedger): boolean {
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
 * One pass over every project's last `decide`. Only the routines owner pushes, so two dashboards on one machine never both send. A pass with no
 * `last-decide.json` changed since the last one reads nothing more; never throws, since it runs inside the routine push fold.
 */
export function foldTickCaps(config: Config, now: number = Date.now()): void {
  try {
    if (!(ownerOverride ?? isOwner)()) return;
    const home = tickHome();
    const seen = decideStats(home);
    if (seen === lastSeen) return;

    const file = ledgerFile(config);
    const before = readLedger(file);
    const { ledger, pushes } = decideTickCapped(before, readTickReadings(home), tickCanSend(config), now);
    memory = ledger;
    lastSeen = seen;
    // Claim before send; a failed write keeps the claim in memory and still sends.
    if (JSON.stringify(ledger) !== JSON.stringify(before)) writeFailed = !writeLedger(file, ledger);
    for (const p of pushes) sendTickCappedEvent(p, config);
  } catch {
    /* a push must never break the routine fold */
  }
}
