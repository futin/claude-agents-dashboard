/**
 * routine-import.ts — the one-time copy of the old shared job folder (`~/claude-global/routines`) into this machine's own jobs folder, so a machine that
 * used to share its jobs through git keeps them, every one disabled until its owner turns it back on. Uses only Node built-ins plus the two shared text
 * editors, and never touches the old folder.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFrontmatterLine } from '../../shared/frontmatter.js';
import { serializeEnabled } from '../../shared/routine-file.js';
import type { Config } from './config.js';
import { OLD_SHARED_DIRS, expandHome, homeOf, realHost, routineDirs } from './routine-config.js';
import type { RoutineHost } from './routine-config.js';

export type ImportResult =
  | { state: 'imported'; from: string; count: number }
  | { state: 'skipped'; why: 'explicit-dir' | 'explicit-old' | 'done' | 'overlap' | 'jobs-exist' | 'no-old' };

const MARKER = 'jobs-imported.json';
const TMP = '.jobs-import.tmp';

/**
 * The three edits an imported job gets, in this order: the dropped `machines:` key and its block items go, `enabled` becomes false, and a job with neither
 * `cwd:` nor `foreach:` gets `cwd:` pointing at the old folder's parent — its default used to be that parent, and the new default is a different folder.
 * Text without a frontmatter block comes back unchanged. Line endings are kept.
 */
export function rewriteImported(text: string, oldParentTilde: string): string {
  const lines = text.split('\n');
  const strip = (l: string): string => l.replace(/\r$/, '');
  const end = strip(lines[0] ?? '').replace(/^﻿/, '') === '---' ? lines.findIndex((l, i) => i >= 1 && strip(l) === '---') : -1;
  if (end === -1) return text;
  const at = lines.findIndex((l, i) => i >= 1 && i < end && l.startsWith('machines:'));
  if (at !== -1) {
    let stop = at + 1;
    while (stop < end && /^[ \t]+-/.test(lines[stop])) stop++;
    lines.splice(at, stop - at);
  }
  let out = serializeEnabled(lines.join('\n'), false);
  if (!/^(cwd|foreach):/m.test(out.slice(0, out.indexOf('\n---', 4)))) out = writeFrontmatterLine(out, 'cwd', oldParentTilde, 'run');
  return out;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Equal, or either one inside the other, compared on a path-separator boundary so `routines-x` is not inside `routines`. */
function overlaps(a: string, b: string): boolean {
  const x = path.resolve(a), y = path.resolve(b);
  return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep);
}

/**
 * Copy the old shared folder's `.md` files into `<state>/jobs` once, disabled. The copy goes to a temp folder and is renamed into place, so a crash leaves
 * no half-filled `jobs/`; the marker is written last, so a crash retries. An explicit `ROUTINES_DIR` is the user's own folder and is never imported into.
 * Also marks done when there is nothing to import or `jobs/` already exists, so a later-restored old folder cannot resurrect deleted jobs.
 */
export function importSharedJobs(config: Config, host: Partial<RoutineHost> = {}): ImportResult {
  const home = homeOf({ ...realHost(), ...host });
  const olds = OLD_SHARED_DIRS.map((d) => expandHome(d, home));
  // An `.env` written before this change can still name the old shared folder; that is a leftover, not a choice, and its files no longer parse.
  if (config.routinesDir) {
    const dir = path.resolve(expandHome(config.routinesDir, home));
    return { state: 'skipped', why: olds.some((o) => path.resolve(o) === dir) ? 'explicit-old' : 'explicit-dir' };
  }
  const dirs = routineDirs(config, host);
  const jobs = dirs.routines;
  const markerPath = path.join(dirs.state, MARKER);
  const mark = (from: string | null, count: number): void => {
    fs.mkdirSync(dirs.state, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ at: new Date().toISOString(), from, count }) + '\n');
  };
  if (fs.existsSync(markerPath)) return { state: 'skipped', why: 'done' };
  if (olds.some((o) => overlaps(jobs, o))) return { state: 'skipped', why: 'overlap' };
  if (fs.existsSync(jobs)) { mark(null, 0); return { state: 'skipped', why: 'jobs-exist' }; }
  const from = olds.find(isDir);
  if (!from) {
    fs.mkdirSync(jobs, { recursive: true });
    mark(null, 0);
    return { state: 'skipped', why: 'no-old' };
  }

  const parent = path.dirname(from);
  const rel = path.relative(home, parent);
  const parentTilde = rel === '' ? '~' : rel.startsWith('..') || path.isAbsolute(rel) ? parent : `~/${rel.split(path.sep).join('/')}`;
  const tmp = path.join(dirs.state, TMP);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.') || !e.name.endsWith('.md')) continue;
    fs.writeFileSync(path.join(tmp, e.name), rewriteImported(fs.readFileSync(path.join(from, e.name), 'utf8'), parentTilde));
    count++;
  }
  fs.renameSync(tmp, jobs);
  mark(from, count);
  return { state: 'imported', from, count };
}
