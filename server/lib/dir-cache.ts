/**
 * dir-cache.ts — a directory's entry list, re-read only when the directory itself changed.
 *
 * The transcript walks (`listTranscripts`, `listUsageTranscripts`, `findTranscript`'s name walk) used to `readdirSync` every project dir on every poll,
 * and that readdir — not the per-file stat — was most of their cost (`docs/subsystems/sessions.md` §"The poll stats every transcript, on purpose").
 * A directory's mtime moves when an entry is added, removed or renamed, so a listing taken after the mtime last moved is still the listing.
 * An append to a file inside does not move it: the callers keep stating every file they list, which is what keeps a resumed old session from lagging.
 *
 * The racy rule is git's "racily clean" index rule: on a filesystem with coarse mtimes (HFS+, some network and WSL mounts — 1 s) an entry created in
 * the same tick as the read leaves the mtime unchanged, so a listing taken within {@link RACY_MS} of the mtime is never trusted.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A listing read less than this long after the directory's mtime is re-read on the next call — see the header. */
export const RACY_MS = 2000;

/** One directory entry: `isDir` is the dirent's own `isDirectory()`, so a symlink to a directory reads `false`. */
export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

interface Held {
  mtimeMs: number;
  ino: number;
  listedAtMs: number;
  entries: readonly DirEntry[];
}

const held = new Map<string, Held>();
let readdirs = 0;

/** Drop the held listings of `dir`'s former child dirs that its new listing no longer names, so the map cannot outgrow the tree. */
function pruneChildren(dir: string, before: readonly DirEntry[] | undefined, after: readonly DirEntry[]): void {
  if (!before) return;
  const kept = new Set(after.filter(e => e.isDir).map(e => e.name));
  for (const e of before) {
    if (e.isDir && !kept.has(e.name)) held.delete(path.join(dir, e.name));
  }
}

/**
 * The entries of `dir`, served from the held listing when the directory's `mtimeMs` and `ino` are unchanged and that listing was read at least
 * {@link RACY_MS} after the mtime; otherwise read again and held. A directory that cannot be stat-ed or read answers `[]` and holds nothing.
 */
export function cachedEntries(dir: string, nowMs: number = Date.now()): readonly DirEntry[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    held.delete(dir);
    return [];
  }
  if (!stat.isDirectory()) {
    held.delete(dir);
    return [];
  }
  const prev = held.get(dir);
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.ino === stat.ino && prev.listedAtMs - stat.mtimeMs >= RACY_MS) return prev.entries;

  let dirents: fs.Dirent[];
  try {
    readdirs++;
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    held.delete(dir);
    return [];
  }
  const entries = dirents.map(d => ({ name: d.name, isDir: d.isDirectory() }));
  pruneChildren(dir, prev?.entries, entries);
  held.set(dir, { mtimeMs: stat.mtimeMs, ino: stat.ino, listedAtMs: nowMs, entries });
  return entries;
}

/** Test seam: directories actually read since the last reset, and listings held now. */
export function dirCacheStats(): { readdirs: number; entries: number } {
  return { readdirs, entries: held.size };
}

/** Test seam: forget every held listing and zero the counter. */
export function resetDirCache(): void {
  held.clear();
  readdirs = 0;
}
