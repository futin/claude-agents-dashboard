/**
 * Matrix's six check columns (Working tree · Push · Pull · Prune · Open branches · Fetched), whether a row has work for Sync, and the header's repo count.
 * Each of Push / Pull / Prune answers "does Sync have something to do here", so a row reads clean only when Sync would do nothing. Pure: no React, no DOM.
 */
import type { FetchClock } from '../../../shared/types';
import { formatAgo } from './format';
import { gitPlural, isStaleBranch, type GitAssessed } from './gitLevels';
import { fetchTroubleWord, gitShownFetchError } from './gitStatsText';
import type { OkRepo } from './gitSync';

/** `plain` is a count in ink, not a check: Open branches is information, never work. */
export type MatrixTone = 'ok' | 'bad' | 'meh' | 'live' | 'na' | 'plain';
export interface MatrixCell { c: MatrixTone; t: string; note?: string }
export interface MatrixCellInput { a: GitAssessed; repo: OkRepo; nowMs: number; clock?: FetchClock }

export const MATRIX_COLUMNS = ['Working tree', 'Push', 'Pull', 'Prune', 'Open branches', 'Fetched'] as const;
/** Working tree, Push, Pull and Prune: the columns whose bad or meh cell means Sync has work. */
const WORK_COLUMNS = 4;

/**
 * The branch's upstream, unless it is absent or is `origin/<trunk>` itself, whose numbers `trunkVsOrigin` already carries. Unlike `gitUpstreamShown`, a level
 * (0 / 0) upstream stays: Inspector's list figure reads it.
 */
export function gitTracked(r: OkRepo): NonNullable<OkRepo['currentVsUpstream']> | null {
  const u = r.currentVsUpstream ?? null;
  if (u === null || (r.trunk !== null && u.upstream === `origin/${r.trunk}`)) return null;
  return u;
}

export interface BranchCount { branch: string; n: number }

/** Commits to push: the trunk's first, then the checked-out branch's, each only when it has some. */
export function pushParts(repo: OkRepo): BranchCount[] {
  return parts(repo, 'ahead');
}

/** Commits to pull, in the same order as `pushParts`. */
export function pullParts(repo: OkRepo): BranchCount[] {
  return parts(repo, 'behind');
}

function parts(repo: OkRepo, side: 'ahead' | 'behind'): BranchCount[] {
  const out: BranchCount[] = [];
  const t = repo.trunkVsOrigin;
  if (repo.trunk !== null && t !== null && t[side] > 0) out.push({ branch: repo.trunk, n: t[side] });
  const u = gitTracked(repo);
  if (repo.branch !== null && u !== null && u.counts !== null && u.counts[side] > 0) out.push({ branch: repo.branch, n: u.counts[side] });
  return out;
}

const said = (ps: BranchCount[]): string => ps.map(p => `${p.n} on ${p.branch}`).join(' · ');

function workingTree({ a, repo }: MatrixCellInput): MatrixCell {
  if (repo.uncommitted === 0) return { c: 'ok', t: 'clean' };
  // An agent already working on the dirty branch is calm, so the cell is a note, not a failure.
  return { c: a.problems.find(p => p.k === 'dirty')?.calm ? 'meh' : 'bad', t: `${repo.uncommitted} uncommitted` };
}

function push({ repo }: MatrixCellInput): MatrixCell {
  if (!repo.hasOrigin) return { c: 'meh', t: 'no remote' };
  const ps = pushParts(repo);
  if (ps.length > 0) return { c: 'meh', t: said(ps) };
  const u = gitTracked(repo);
  if (u !== null && u.counts === null) return { c: 'meh', t: `${u.upstream} gone` };
  return { c: 'ok', t: 'nothing' };
}

function pull({ repo }: MatrixCellInput): MatrixCell {
  if (!repo.hasOrigin) return { c: 'na', t: '—' };
  const ps = pullParts(repo);
  return ps.length > 0 ? { c: 'bad', t: said(ps) } : { c: 'ok', t: 'up to date' };
}

function prune({ repo }: MatrixCellInput): MatrixCell {
  return repo.mergedCount > 0 ? { c: 'meh', t: `${repo.mergedCount} merged` } : { c: 'ok', t: 'nothing' };
}

function openBranches({ repo, nowMs }: MatrixCellInput): MatrixCell {
  if (repo.unmergedTotal === 0) return { c: 'na', t: '0' };
  const s = repo.branches.filter(b => isStaleBranch(b, nowMs)).length;
  return s > 0 ? { c: 'plain', t: String(repo.unmergedTotal), note: `${s} stale` } : { c: 'plain', t: String(repo.unmergedTotal) };
}

function fetched({ repo, clock }: MatrixCellInput): MatrixCell {
  if (clock?.runningSinceMs != null && repo.hasOrigin) return { c: 'live', t: 'fetching…' };
  const e = gitShownFetchError(repo);
  if (e !== null) return { c: 'bad', t: `${fetchTroubleWord(e)} · ${repo.fetchedAtMs === null ? 'never' : formatAgo(repo.fetchedAtMs)}` };
  if (repo.fetchedAtMs !== null) return { c: 'ok', t: formatAgo(repo.fetchedAtMs) };
  return { c: 'na', t: 'never' };
}

const CELLS = [workingTree, push, pull, prune, openBranches, fetched];

/** One readable repo's cells, in `MATRIX_COLUMNS` order. */
export function matrixCells(i: MatrixCellInput): MatrixCell[] {
  return CELLS.map(f => f(i));
}

/** Whether Sync has something to do for this row: any Working tree / Push / Pull / Prune cell is bad or meh. Open branches and Fetched never count. */
export function matrixRowHasWork(cells: readonly MatrixCell[]): boolean {
  return cells.slice(0, WORK_COLUMNS).some(c => c.c === 'bad' || c.c === 'meh');
}

/** A column header's second line: how many repos have work in it. Repos, never branches, so it says so. */
export function matrixHeaderCount(n: number): string {
  return n === 0 ? '' : gitPlural(n, 'repo');
}
