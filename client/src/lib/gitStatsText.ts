import type { GitBranch, RepoGitStats } from '../../../shared/types';
import { formatAgo } from './format';

/**
 * Every string of the Git sub-view's copy table (spec §6), kept out of the components so a wording change is one edit and the exact text is testable.
 * Pure: no React, no DOM, no clock beyond `formatAgo`'s own.
 */

type OkRepo = Extract<RepoGitStats, { state: 'ok' }>;

/** Branches shown before "+N more" (spec §6). */
export const GIT_BRANCHES_SHOWN = 5;
/** The server's per-repo cap on `branches`; `unmergedTotal` above it means some are not listed. */
export const GIT_BRANCH_CAP = 50;

export const GIT_NO_OPEN_BRANCHES = 'no open branches';
export const GIT_NO_PINS = 'No pinned projects yet. Pin one under Pinned.';
export const GIT_LOAD_FAILED = "Couldn't load git stats. Retrying every 30s.";
export const GIT_UPDATE_FAILED = "couldn't update";

/** The branch chip: the branch name, or the short sha while HEAD is detached. */
export function gitBranchChipText(r: OkRepo): string {
  return r.branch === null ? `detached at ${r.detachedSha}` : r.branch;
}

export function gitUncommittedText(n: number): string {
  return n > 0 ? `${n} uncommitted` : 'clean';
}

/**
 * Local trunk against origin's. `trunkVsOrigin: null` alone is ambiguous, so the null cases read `hasOrigin` and `trunkRefs`. A trunk-less repo says "no main
 * branch" even with an origin: there is no trunk to name.
 */
export function gitTrunkVsOriginText(r: OkRepo): string {
  if (r.trunk === null) return 'no main branch';
  if (!r.hasOrigin) return 'no remote';
  const d = r.trunkVsOrigin;
  if (d) {
    if (d.ahead === 0 && d.behind === 0) return `${r.trunk} = origin`;
    if (d.ahead === 0) return `${r.trunk} ${d.behind} behind origin`;
    if (d.behind === 0) return `${r.trunk} ${d.ahead} ahead of origin`;
    return `${r.trunk} ${d.ahead} ahead, ${d.behind} behind origin`;
  }
  return r.trunkRefs !== null && r.trunkRefs.origin ? `${r.trunk} only on origin` : `${r.trunk} not on origin`;
}

/** The age of the last fetch. `formatAgo` clamps a future mtime (clock skew) to "0s", so this never prints a negative age. */
export function gitFetchedText(fetchedAtMs: number | null): string {
  return fetchedAtMs === null ? 'never fetched' : `fetched ${formatAgo(fetchedAtMs)} ago`;
}

/** "+N more" for a branch list of `branchCount`, which is `branches.length`, not `unmergedTotal`. */
export function gitMoreText(branchCount: number): string {
  return `+${branchCount - GIT_BRANCHES_SHOWN} more`;
}

/** The muted line under an expanded list when the server capped it: `unmergedTotal` is what exists, the cap is what it sent. */
export function gitNotShownText(unmergedTotal: number): string {
  return `${unmergedTotal - GIT_BRANCH_CAP} more not shown (over ${GIT_BRANCH_CAP})`;
}

export function gitMergedText(mergedCount: number): string {
  return `${mergedCount} merged branches hidden`;
}

/** The one sentence that replaces a non-`ok` repo's body, so broken numbers are never drawn. */
export function gitStateSentence(r: Exclude<RepoGitStats, { state: 'ok' }>): string {
  switch (r.state) {
    case 'missing': return r.path === null ? 'Folder is gone. Unpin it under Pinned.' : `Folder is gone — ${r.path}. Unpin it under Pinned.`;
    case 'not-git': return 'Not a git repository.';
    case 'error': return `Couldn't read: ${r.message}`;
  }
}

/**
 * A branch's divergence numbers, or null when it has none to show. Keys on `ahead`/`behind` rather than on the repo's `trunk`: a trunk can be named while no
 * base ref exists to compare against (a dangling origin/HEAD), and the branch then carries nulls.
 */
export function gitBranchCounts(b: GitBranch): { ahead: number; behind: number } | null {
  return b.ahead === null || b.behind === null ? null : { ahead: b.ahead, behind: b.behind };
}

/** The newest few branches, or all of them once the list is expanded. */
export function gitVisibleBranches(branches: GitBranch[], expanded: boolean): GitBranch[] {
  return expanded ? branches : branches.slice(0, GIT_BRANCHES_SHOWN);
}
