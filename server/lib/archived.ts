/**
 * archived.ts — which sessions the Claude Code desktop app has archived.
 *
 * "Delete" in the app's session list is an **archive**: it flips `isArchived`
 * in the app's own record and never touches `~/.claude/projects/*.jsonl`, so a
 * deleted session keeps a transcript on disk and the dashboard keeps showing it
 * until it ages out of the lookback window. Reading the flag is what mirrors the
 * app's list — and it mirrors un-deleting for free, since reopening from the
 * Archived list rewrites the record.
 *
 * The store is one JSON file per session:
 * `~/Library/Application Support/Claude/claude-code-sessions/<install>/<account>/local_<uuid>.json`.
 * Both path segments are wildcards — a second signed-in account adds a second
 * account directory. The app's own `sessionId` (`local_<uuid>`) is *not* the
 * transcript's name; `cliSessionId` is, and it's the only join key to
 * `~/.claude/projects`. A record without one never started a CLI run.
 *
 * **This module is the only place that touches the app's store.** The call sites
 * that filter take the id set as an argument (`scanSessions`, `listRecentProjects`),
 * so they stay pure and their tmpdir fixtures keep working with no store present.
 *
 * Fail open, always: a missing directory (every non-macOS host), an unreadable
 * file, malformed JSON, an absent flag — all return "not archived" and hide
 * nothing. Wrongly hiding a live session is the harmful direction.
 *
 * `desktopLiveSessionIds` is a second verdict from the same pass over the same files, with the **inverse** failure direction. It names the sessions the app holds open, so a
 * session the dashboard must not resume or hand over (a second writer on one transcript, spec decision 11 of the desktop-launch design). A false "not
 * owned" admits that second writer, so a record is live unless `isArchived` is exactly `true` — an absent or odd flag counts as live — and every
 * shortcut may only ever add a live id, never drop one. What it cannot read it cannot attribute: a missing root, an unreadable or malformed record, or
 * one with no string `cliSessionId` contributes nothing, and the rest are still read.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

export interface ArchivedOptions {
  /** Store root override (tests). Wins over homeDir. */
  root?: string;
  /** $HOME override (tests). */
  homeDir?: string;
}

/** Where the desktop app keeps its session records. macOS layout. */
export function appSessionsRoot(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

/**
 * Verdict cache, keyed by absolute path, one entry per record holding both verdicts from one classification pass: `archivedId` is the record's
 * `cliSessionId` when it is archived, `liveId` its `cliSessionId` when it is not — each null in every other case (no CLI run, unreadable). One map, so a
 * poll that asks both readers opens each record at most once. Keyed on mtime because a full parse of the store is not affordable against a 3 s poll —
 * measured 2026-09-01 on a 669-record store, stat-sweeping all of them costs 3 ms while parsing all of them costs 4.0 s; the store has since grown to
 * 1,646 records, 227 MB (2026-11-25), and a cold pass of both readers cost ~5.6 s. Archiving rewrites the record, so its mtime moves and the next sweep
 * re-reads it. `warmDesktopStore` fills it at startup so that cold pass is not paid on the first poll.
 */
const cache = new Map<string, Verdicts>();

interface Verdicts {
  mtimeMs: number;
  archivedId: string | null;
  liveId: string | null;
}

/** Bytes read to *rule out* an archive without parsing the whole record. */
const PREFIX_BYTES = 8192;

/** Reset the verdict cache (tests). */
export function resetArchivedCache(): void {
  cache.clear();
}

/** Every `local_*.json` under `<root>/<install>/<account>/`, with its mtime. */
function listRecords(root: string): { file: string; mtimeMs: number }[] {
  const out: { file: string; mtimeMs: number }[] = [];
  for (const install of subdirs(root)) {
    for (const account of subdirs(install)) {
      let names: string[];
      try {
        names = fs.readdirSync(account);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const file = path.join(account, name);
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) out.push({ file, mtimeMs: stat.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  }
  return out;
}

/** Absolute paths of the directories directly under `dir`. */
function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Both verdicts for one record, from at most one prefix read and at most one full `JSON.parse`.
 *
 * Two-step on purpose. The records are ~200 KB each — they embed `remoteMcpServersConfig` with full tool descriptions — but `isArchived` and
 * `cliSessionId` are top-level fields sitting in the first few hundred bytes, so a prefix read rules out the ~95% of records that are live for 0.7 ms
 * instead of 6 ms. That prefix scan is a regex over partial JSON, so each verdict trusts it only in its safe direction:
 *
 * - `archivedId` trusts it only to say **"not archived"**: hiding a session always costs a real `JSON.parse`, so a false positive in the cheap path can't
 *   reach the caller.
 * - `liveId` trusts it only to confirm a live record whose id it shows exactly once, so it can add an id but never drop one; anything it cannot settle — an
 *   archive flag in view, no id, two ids — takes the full parse.
 *
 * A verdict that needed the parse is null when the file is unreadable or malformed.
 */
function classifyRecord(file: string): { archivedId: string | null; liveId: string | null } {
  const prefix = readPrefix(file);
  const provenLive = prefix !== null && /"isArchived"\s*:\s*false/.test(prefix) && !/"isArchived"\s*:\s*true/.test(prefix);

  let liveFromPrefix: string | null = null;
  if (provenLive) {
    const ids = [...prefix.matchAll(/"cliSessionId"\s*:\s*"([^"\\]+)"/g)];
    if (ids.length === 1 && !/"cliSessionId"\s*:\s*(?!")/.test(prefix)) liveFromPrefix = ids[0]![1]!;
  }
  if (provenLive && liveFromPrefix !== null) return { archivedId: null, liveId: liveFromPrefix };

  let record: { isArchived?: unknown; cliSessionId?: unknown };
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { archivedId: null, liveId: null };
  }
  const id = typeof record?.cliSessionId === 'string' && record.cliSessionId ? record.cliSessionId : null;
  const archived = record?.isArchived === true;
  return {
    archivedId: provenLive || !archived ? null : id,
    liveId: archived ? null : id
  };
}

/** First `PREFIX_BYTES` of a file as text, or null if unreadable. */
function readPrefix(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(PREFIX_BYTES);
    const read = fs.readSync(fd, buf, 0, PREFIX_BYTES, 0);
    return buf.toString('utf8', 0, read);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Bring the cache in line with the store under `root`: re-classify only the records whose mtime moved, and drop the entries for records no longer there.
 * Records the app deleted for real (or another store root's, in tests) must not keep answering from the cache.
 */
function sweep(root: string): void {
  const seen = new Set<string>();
  for (const rec of listRecords(root)) {
    seen.add(rec.file);
    const cached = cache.get(rec.file);
    if (cached && cached.mtimeMs === rec.mtimeMs) continue;
    cache.set(rec.file, { mtimeMs: rec.mtimeMs, ...classifyRecord(rec.file) });
  }
  for (const file of cache.keys()) {
    if (!seen.has(file) && file.startsWith(root + path.sep)) cache.delete(file);
  }
}

/** The non-null `field` of every cached record under `root`. */
function project(root: string, field: 'archivedId' | 'liveId'): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [file, v] of cache) {
    const id = v[field];
    if (id && file.startsWith(root + path.sep)) ids.add(id);
  }
  return ids;
}

/**
 * Transcript ids (`cliSessionId`) of every session the app has archived.
 *
 * Empty when the store is absent or unreadable — nothing is hidden. Cheap
 * enough to call once per poll: a stat sweep plus a re-read of only the records
 * whose mtime advanced.
 */
export function archivedSessionIds(options: ArchivedOptions = {}): ReadonlySet<string> {
  const root = options.root || appSessionsRoot(options.homeDir);
  sweep(root);
  return project(root, 'archivedId');
}

/**
 * Transcript ids (`cliSessionId`) of every session the app holds in a non-archived record: the sessions a second writer must not touch.
 *
 * Empty when the store is absent. Same sweep as {@link archivedSessionIds}, over the same cache, so the second of the two calls a poll makes opens no
 * record. HOME is resolved at call time (`appSessionsRoot`), so a test can point it at a fixture.
 */
export function desktopLiveSessionIds(options: ArchivedOptions = {}): ReadonlySet<string> {
  const root = options.root || appSessionsRoot(options.homeDir);
  sweep(root);
  return project(root, 'liveId');
}

/**
 * Classify every record the cache lacks or holds at an older mtime, yielding to the event loop between records, so the first poll after a restart
 * finds the cache warm instead of classifying the whole store synchronously on the request path. Writes the same verdict a sweep would for the same
 * mtime, so a poll that lands mid-warm is still correct. Never deletes an entry (that stays the sweep's job) and never rejects: an absent root (every
 * non-macOS host) resolves at once.
 */
export async function warmDesktopStore(options: ArchivedOptions = {}): Promise<void> {
  try {
    const root = options.root || appSessionsRoot(options.homeDir);
    for (const rec of listRecords(root)) {
      const cached = cache.get(rec.file);
      if (!cached || cached.mtimeMs < rec.mtimeMs) cache.set(rec.file, { mtimeMs: rec.mtimeMs, ...classifyRecord(rec.file) });
      await yieldToLoop();
    }
  } catch {
    // Best-effort: whatever is cached stays cached, and the sweep covers the rest on the request path.
  }
}
