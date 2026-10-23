/**
 * codegraph.ts — reads the `codegraph` CLI's state for each pinned project, for the Management tab's CodeGraph sub-view.
 *
 * Design: `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` §Data. Node built-ins only; the CLI is launched through `execFile` / `spawn` (argv, no
 * shell) and never imported. This file holds the pure readers (status parser, graph-root walk, pid files); caching, runs and the HTTP surface live elsewhere.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { CodegraphIndexState, CodegraphStats, PinRow } from '../../shared/types.js';

/** Exit code and output of one CLI call. Rejects only when the spawn fails (error keeps its `code`, e.g. `ENOENT`) or the timeout fires (`ETIMEDOUT`). */
export type CodegraphRunner = (cwd: string, args: string[], timeoutMs: number | null) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What one status read found; `cli-missing` is for the page to say once, not per repo. */
export type StatusRead =
  | { kind: 'ok'; root: string; stats: CodegraphStats }
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'error'; root: string; message: string }
  | { kind: 'cli-missing' };

/** `process.env` plus the two switches that keep the npm shim from checking for, or downloading, a newer bundle on every launch. */
export const CODEGRAPH_ENV: NodeJS.ProcessEnv = { ...process.env, CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1' };

/** Longest a status read may take; the slowest repo measured 2.3 s on 2026-10-19. */
export const CODEGRAPH_STATUS_TIMEOUT_MS = 15_000;

/** The CLI prints this when it loses the database file lock; a run ending non-zero with it is the watcher's write, not a failure (spec §Lock-loss). */
export const LOCK_LOSS_TEXT = 'could not acquire the file lock';

const MAX_BUFFER = 8 * 1024 * 1024;

function timeoutError(): Error {
  return Object.assign(new Error('codegraph timed out'), { code: 'ETIMEDOUT' });
}

/** The real runner, with a knob only tests turn: a `bin` that is not codegraph. */
export function makeCodegraphRunner(bin = 'codegraph'): CodegraphRunner {
  return (cwd, args, timeoutMs) =>
    timeoutMs === null ? spawnToEnd(bin, cwd, args) : execWithTimer(bin, cwd, args, timeoutMs);
}

// The timer is its own because `execFile`'s `timeout` can report success with empty output when the event loop stalls (git-stats.ts, #168).
function execWithTimer(bin: string, cwd: string, args: string[], timeoutMs: number): ReturnType<CodegraphRunner> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(bin, args, { cwd, env: CODEGRAPH_ENV, encoding: 'utf8', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null };
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
      if (timedOut && e.signal) return reject(timeoutError());
      reject(err);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  });
}

// Runs (sync, reindex) can take minutes, so no timer; stdin is closed so `index` never waits on a prompt.
function spawnToEnd(bin: string, cwd: string, args: string[]): ReturnType<CodegraphRunner> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: CODEGRAPH_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    // A signal death reports a null code; 1 keeps it a failure.
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The runner every launch goes through unless a test swaps it. */
export const defaultCodegraphRunner: CodegraphRunner = makeCodegraphRunner();

let runnerOverride: CodegraphRunner | null = null;

/** Swaps the runner for tests; null restores the real one. */
export function overrideCodegraphRunner(r: CodegraphRunner | null): void {
  runnerOverride = r;
}

/** The runner in force. */
export function currentCodegraphRunner(): CodegraphRunner {
  return runnerOverride ?? defaultCodegraphRunner;
}

const INDEX_STATES: readonly string[] = ['indexing', 'complete', 'partial', 'failed'];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The view's fields out of `codegraph status --json` stdout, or `'uninitialized'`. Throws an `Error` with a one-line reason when the output is unusable. */
export function parseCodegraphStatus(stdout: string): CodegraphStats | 'uninitialized' {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error('status output is not JSON');
  }
  if (!isRecord(raw)) throw new Error('status output is not a JSON object');
  if (raw.initialized === false) return 'uninitialized';

  const counts: Record<'fileCount' | 'nodeCount' | 'edgeCount' | 'dbSizeBytes', number> = { fileCount: 0, nodeCount: 0, edgeCount: 0, dbSizeBytes: 0 };
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    const n = num(raw[key]);
    if (n === null) throw new Error(`status output has no numeric ${key}`);
    counts[key] = n;
  }

  const index = isRecord(raw.index) ? raw.index : {};
  const pendingRaw = isRecord(raw.pendingChanges) ? raw.pendingChanges : {};
  const mismatch = isRecord(raw.worktreeMismatch) ? raw.worktreeMismatch : null;
  const lastIndexed = typeof raw.lastIndexed === 'string' ? Date.parse(raw.lastIndexed) : NaN;

  const nodesByKind: Record<string, number> = {};
  if (isRecord(raw.nodesByKind)) {
    for (const [kind, n] of Object.entries(raw.nodesByKind)) if (num(n) !== null) nodesByKind[kind] = n as number;
  }

  return {
    lastIndexedMs: Number.isNaN(lastIndexed) ? null : lastIndexed,
    ...counts,
    nodesByKind,
    languages: Array.isArray(raw.languages) ? raw.languages.filter((l): l is string => typeof l === 'string') : [],
    pending: { added: num(pendingRaw.added) ?? 0, modified: num(pendingRaw.modified) ?? 0, removed: num(pendingRaw.removed) ?? 0 },
    worktreeMismatch:
      mismatch && typeof mismatch.worktreeRoot === 'string' && typeof mismatch.indexRoot === 'string'
        ? { worktreeRoot: mismatch.worktreeRoot, indexRoot: mismatch.indexRoot }
        : null,
    version: typeof raw.version === 'string' ? raw.version : '',
    // A CLI null means the index predates the marker.
    indexState: (typeof index.state === 'string' && INDEX_STATES.includes(index.state) ? index.state : 'complete') as CodegraphIndexState,
    reindexRecommended: index.reindexRecommended === true,
    builtWithVersion: typeof index.builtWithVersion === 'string' ? index.builtWithVersion : null,
    builtWithExtractionVersion: num(index.builtWithExtractionVersion),
    currentExtractionVersion: num(index.currentExtractionVersion),
  };
}

/** A pid file's contents: JSON `{pid, startedAt}` (`startedAt` is epoch ms) or a bare integer; null when absent or unparsable. */
export async function readPidFile(file: string): Promise<{ pid: number; startedAtMs: number | null } | null> {
  let text: string;
  try {
    text = (await fs.promises.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return pid > 0 ? { pid, startedAtMs: null } : null;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || !Number.isInteger(raw.pid) || (raw.pid as number) <= 0) return null;
    return { pid: raw.pid as number, startedAtMs: num(raw.startedAt) };
  } catch {
    return null;
  }
}

/** Whether a process with this pid exists; `EPERM` means it does, under another user. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid file's content when its process is alive; a crashed process leaves its file behind. */
export async function livePid(file: string): Promise<{ pid: number; startedAtMs: number | null } | null> {
  const p = await readPidFile(file);
  return p && isPidAlive(p.pid) ? p : null;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `dir` or its nearest ancestor whose `.codegraph/` holds `codegraph.db` (the CLI's own walk; a bare `.codegraph/` does not count) or a live `rebuild.pid`,
 * since `index` unlinks and recreates the DB and mid-rebuild the file can be briefly absent. Null when there is none.
 */
export async function findGraphRoot(dir: string): Promise<string | null> {
  let cur = path.resolve(dir);
  for (;;) {
    const meta = path.join(cur, '.codegraph');
    if ((await isFile(path.join(meta, 'codegraph.db'))) || (await livePid(path.join(meta, 'rebuild.pid')))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function lastLine(text: string): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

/**
 * One pin's `codegraph status --json`. Never rejects: a CLI failure becomes `error` so the other repos are unaffected. The CLI runs with `cwd` = the pin's
 * own path, not the graph root, because its `worktreeMismatch` compares the start path with the root it walks up to.
 */
export async function readCodegraphStatus(pin: PinRow, run: CodegraphRunner): Promise<StatusRead> {
  if (pin.path === null || !pin.listed || !(await isDirectory(pin.path))) return { kind: 'missing' };
  const root = await findGraphRoot(pin.path);
  if (root === null) return { kind: 'none' };

  try {
    const res = await run(pin.path, ['status', '--json'], CODEGRAPH_STATUS_TIMEOUT_MS);
    if (res.code !== 0) return { kind: 'error', root, message: lastLine(res.stderr) ?? lastLine(res.stdout) ?? `exit ${res.code}` };
    const stats = parseCodegraphStatus(res.stdout);
    return stats === 'uninitialized' ? { kind: 'none' } : { kind: 'ok', root, stats };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === 'ETIMEDOUT') return { kind: 'error', root, message: 'codegraph status timed out' };
    // A missing cwd fails the spawn with the same ENOENT as a missing binary, so a folder removed since the stat would read as "codegraph not found".
    if (e.code === 'ENOENT') return (await isDirectory(pin.path)) ? { kind: 'cli-missing' } : { kind: 'missing' };
    return { kind: 'error', root, message: typeof e.message === 'string' && e.message ? e.message : 'codegraph status failed' };
  }
}
