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
 * `desktopLiveSessionIds` is a second reader of the same files with the **inverse** failure direction. It names the sessions the app holds open, so a
 * session the dashboard must not resume or hand over (a second writer on one transcript, spec decision 11 of the desktop-launch design). A false "not
 * owned" admits that second writer, so a record is live unless `isArchived` is exactly `true` — an absent or odd flag counts as live — and every
 * shortcut may only ever add a live id, never drop one. What it cannot read it cannot attribute: a missing root, an unreadable or malformed record, or
 * one with no string `cliSessionId` contributes nothing, and the rest are still read.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * Verdict cache, keyed by absolute path: `archivedId` is the record's
 * `cliSessionId` when it is archived, null in every other case (live, no CLI
 * run, unreadable). Keyed on mtime because a full parse of the store is not
 * affordable against a 3 s poll — measured 2026-09-01 on a 669-record store, stat-sweeping
 * all of them costs 3 ms while parsing all of them costs 4.0 s. Archiving
 * rewrites the record, so its mtime moves and the next sweep re-reads it.
 */
const cache = new Map<string, { mtimeMs: number; archivedId: string | null }>();

/** Same keying as `cache`, for the live reader: `liveId` is the `cliSessionId` of a non-archived record, null otherwise. Separate map, separate verdict. */
const liveCache = new Map<string, { mtimeMs: number; liveId: string | null }>();

/** Bytes read to *rule out* an archive without parsing the whole record. */
const PREFIX_BYTES = 8192;

/** Reset the verdict cache (tests). */
export function resetArchivedCache(): void {
  cache.clear();
  liveCache.clear();
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
 * The `cliSessionId` this record archives, or null.
 *
 * Two-step on purpose. The records are ~200 KB each — they embed
 * `remoteMcpServersConfig` with full tool descriptions — but `isArchived` and
 * `cliSessionId` are top-level fields sitting in the first few hundred bytes, so
 * a prefix read rules out the ~95% of records that are live for 0.7 ms instead
 * of 6 ms. That prefix scan is a regex over partial JSON, so it is only ever
 * trusted to say **"not archived"**: hiding a session always costs a real
 * `JSON.parse`, and a false positive in the cheap path can't reach the caller.
 */
function classify(file: string): string | null {
  const prefix = readPrefix(file);
  if (prefix && /"isArchived"\s*:\s*false/.test(prefix) && !/"isArchived"\s*:\s*true/.test(prefix)) return null;

  let record: { isArchived?: unknown; cliSessionId?: unknown };
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (record?.isArchived !== true) return null;
  const id = record.cliSessionId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The `cliSessionId` this record keeps live, or null: the mirror of {@link classify}. The prefix scan is trusted only to confirm a live record whose id it
 * shows exactly once, so it can add an id but never drop one; anything it cannot settle — an archive flag in view, no id, two ids — takes a full parse.
 */
function classifyLive(file: string): string | null {
  const prefix = readPrefix(file);
  if (prefix && /"isArchived"\s*:\s*false/.test(prefix) && !/"isArchived"\s*:\s*true/.test(prefix)) {
    const ids = [...prefix.matchAll(/"cliSessionId"\s*:\s*"([^"\\]+)"/g)];
    if (ids.length === 1 && !/"cliSessionId"\s*:\s*(?!")/.test(prefix)) return ids[0]![1]!;
  }

  let record: { isArchived?: unknown; cliSessionId?: unknown };
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (record?.isArchived === true) return null;
  const id = record?.cliSessionId;
  return typeof id === 'string' && id ? id : null;
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
 * Transcript ids (`cliSessionId`) of every session the app has archived.
 *
 * Empty when the store is absent or unreadable — nothing is hidden. Cheap
 * enough to call once per poll: a stat sweep plus a re-read of only the records
 * whose mtime advanced.
 */
export function archivedSessionIds(options: ArchivedOptions = {}): ReadonlySet<string> {
  const root = options.root || appSessionsRoot(options.homeDir);
  const seen = new Set<string>();

  for (const rec of listRecords(root)) {
    seen.add(rec.file);
    const cached = cache.get(rec.file);
    if (cached && cached.mtimeMs === rec.mtimeMs) continue;
    cache.set(rec.file, { mtimeMs: rec.mtimeMs, archivedId: classify(rec.file) });
  }

  // Records the app deleted for real (or another store root's, in tests) must
  // not keep answering from the cache.
  for (const file of cache.keys()) {
    if (!seen.has(file) && file.startsWith(root + path.sep)) cache.delete(file);
  }

  const ids = new Set<string>();
  for (const [file, v] of cache) {
    if (v.archivedId && file.startsWith(root + path.sep)) ids.add(v.archivedId);
  }
  return ids;
}

/**
 * Transcript ids (`cliSessionId`) of every session the app holds in a non-archived record: the sessions a second writer must not touch.
 *
 * Empty when the store is absent. Same cost profile as {@link archivedSessionIds}: a stat sweep plus a re-read of only the records whose mtime advanced.
 * HOME is resolved at call time (`appSessionsRoot`), so a test can point it at a fixture.
 */
export function desktopLiveSessionIds(options: ArchivedOptions = {}): ReadonlySet<string> {
  const root = options.root || appSessionsRoot(options.homeDir);
  const seen = new Set<string>();

  for (const rec of listRecords(root)) {
    seen.add(rec.file);
    const cached = liveCache.get(rec.file);
    if (cached && cached.mtimeMs === rec.mtimeMs) continue;
    liveCache.set(rec.file, { mtimeMs: rec.mtimeMs, liveId: classifyLive(rec.file) });
  }

  for (const file of liveCache.keys()) {
    if (!seen.has(file) && file.startsWith(root + path.sep)) liveCache.delete(file);
  }

  const ids = new Set<string>();
  for (const [file, v] of liveCache) {
    if (v.liveId && file.startsWith(root + path.sep)) ids.add(v.liveId);
  }
  return ids;
}
