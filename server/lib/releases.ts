// The dashboard's own release history, served at GET /api/releases (docs/subsystems/releases.md). release-kit reads the tags; this file only decides
// when a read is due.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readReleases } from 'release-kit';

import type { ReleasesResponse } from '../../shared/types.js';
import { repoRoot } from './usage-history.js';

let rootOverride: string | null = null;
let memo: { key: string; body: Promise<ReleasesResponse> } | null = null;
let reads = 0;

/** Point the reader at `dir` instead of the dashboard's own checkout; `null` restores it. Clears the memo and the read count. Tests only. */
export function overrideReleasesRoot(dir: string | null): void {
  rootOverride = dir;
  memo = null;
  reads = 0;
}

/** How many times the tags were actually read since the last {@link overrideReleasesRoot}. Tests only. */
export function releasesReadCount(): number {
  return reads;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * What a read depends on: HEAD (a commit moves `ahead`), and the tag refs under the *common* dir — a worktree's own `.git` is a file and holds no tags,
 * and a fetched or hand-cut tag moves no HEAD. `refs/tags` changes when a loose tag is added or removed, `packed-refs` when packing rewrites the list.
 * `null` when git cannot answer, which is never memoised.
 */
async function releasesKey(root: string): Promise<string | null> {
  try {
    const [head, common] = (await git(root, ['rev-parse', 'HEAD', '--git-common-dir'])).split('\n');
    const dir = path.resolve(root, common);
    return `${head} ${mtime(path.join(dir, 'packed-refs'))} ${mtime(path.join(dir, 'refs', 'tags'))}`;
  } catch {
    return null;
  }
}

function read(root: string): Promise<ReleasesResponse> {
  reads++;
  return readReleases(root);
}

/** The memoised read. Concurrent requests under one key share one read; release-kit never rejects, so neither does this. */
export async function releasesPayload(): Promise<ReleasesResponse> {
  const root = rootOverride ?? repoRoot();
  const key = await releasesKey(root);
  if (key === null) return read(root);
  if (memo?.key !== key) memo = { key, body: read(root) };
  return memo.body;
}
