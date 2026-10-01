import { useState } from 'react';

import type { GitBranch, RepoGitStats } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { gitBarMax, gitBarWidth } from '../../lib/gitBar';
import {
  GIT_BRANCHES_SHOWN, GIT_BRANCH_CAP, GIT_NO_OPEN_BRANCHES,
  gitBranchChipText, gitBranchCounts, gitFetchedText, gitMergedText, gitMoreText, gitNotShownText, gitTrunkVsOriginText, gitUncommittedText,
  gitVisibleBranches,
} from '../../lib/gitStatsText';
import { triageGitRepos, type GitTriageGroup } from '../../lib/gitTriage';

/**
 * The pieces every Git layout shares (spec §6 "Shared repo facts"): the status dot, the repo-level chips, the divergence bar and the branch list with its
 * "+N more" / merged lines. The three layouts differ only in how they arrange these.
 */

import type { OkRepo } from '../../lib/gitSync';

export type { OkRepo };

/** Each repo's Triage group, so Cards and Triage colour the same repo's dot the same way. */
export function gitGroupsByDir(repos: RepoGitStats[]): Map<string, GitTriageGroup> {
  const out = new Map<string, GitTriageGroup>();
  const groups = triageGitRepos(repos);
  for (const g of Object.keys(groups) as GitTriageGroup[]) for (const r of groups[g]) out.set(r.dirName, g);
  return out;
}

/** Amber needs you, mustard in flight, green quiet, ink3 unreadable — the Triage rule as one glyph. */
export function GitDot({ group }: { group: GitTriageGroup | undefined }) {
  return <span className={`git-dot ${group ?? 'unreadable'}`} aria-hidden="true" />;
}

export function GitBranchChip({ repo }: { repo: OkRepo }) {
  return <span className="git-chip branch">{gitBranchChipText(repo)}</span>;
}

export function GitUncommittedChip({ repo }: { repo: OkRepo }) {
  return <span className={`git-chip ${repo.uncommitted > 0 ? 'amber' : 'green'}`}>{gitUncommittedText(repo.uncommitted)}</span>;
}

/** Mustard only when the local trunk and origin's have actually diverged; the null cases ("no remote", "not on origin", …) stay neutral. */
export function GitTrunkChip({ repo }: { repo: OkRepo }) {
  const d = repo.trunkVsOrigin;
  const diverged = d !== null && (d.ahead > 0 || d.behind > 0);
  return <span className={`git-chip${diverged ? ' mustard' : ''}`}>{gitTrunkVsOriginText(repo)}</span>;
}

export function GitFetched({ repo }: { repo: OkRepo }) {
  return <span className="git-fetched">{gitFetchedText(repo.fetchedAtMs)}</span>;
}

/** Behind grows left from the centre line, ahead grows right; `max` is the repo's scale (`gitBarMax`). */
export function GitDivergenceBar({ ahead, behind, max }: { ahead: number; behind: number; max: number }) {
  return (
    <span className="git-bar" aria-hidden="true">
      <i className="git-bar-b" style={{ width: gitBarWidth(behind, max) }} />
      <i className="git-bar-c" />
      <i className="git-bar-a" style={{ width: gitBarWidth(ahead, max) }} />
    </span>
  );
}

export function GitNums({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <span className="git-nums" aria-label={`${behind} behind, ${ahead} ahead`}>
      <span className="git-nums-b">{behind}</span> | <span className="git-nums-a">{ahead}</span>
    </span>
  );
}

export function GitWorktreeBadge({ b }: { b: GitBranch }) {
  return b.worktreePath === null ? null : <span className="git-chip wt">worktree</span>;
}

/**
 * One branch as a grid row: name (+ worktree badge), bar, numbers, last-commit age. A branch with no counts (no trunk, or no base ref to measure against)
 * draws neither bar nor numbers — keyed on the branch's own counts, not on `repo.trunk`.
 */
function GitBranchRow({ b, max }: { b: GitBranch; max: number }) {
  const c = gitBranchCounts(b);
  return (
    <div className="git-brow">
      <span className="git-bname"><span className="git-bname-t">{b.name}</span><GitWorktreeBadge b={b} /></span>
      {/* The count-less placeholders keep the grid's columns; the bar's carries `git-bar` so the phone rule that drops the bar drops it too. */}
      {c ? <GitDivergenceBar ahead={c.ahead} behind={c.behind} max={max} /> : <span className="git-bar" aria-hidden="true" />}
      {c ? <GitNums ahead={c.ahead} behind={c.behind} /> : <span />}
      <span className="git-age">{formatAgo(b.lastCommitMs)}</span>
    </div>
  );
}

/**
 * A repo's unmerged branches: the newest five, "+N more" expanding the rest inline, the capped-list note once expanded, then the muted merged line. "no open
 * branches" when there are none.
 */
export function GitBranchList({ repo }: { repo: OkRepo }) {
  const [expanded, setExpanded] = useState(false);
  const max = gitBarMax(repo.branches);
  const hidden = repo.branches.length > GIT_BRANCHES_SHOWN && !expanded;
  return (
    <div className="git-branches">
      {repo.branches.length === 0
        ? <div className="git-note">{GIT_NO_OPEN_BRANCHES}</div>
        : gitVisibleBranches(repo.branches, expanded).map(b => <GitBranchRow key={b.name} b={b} max={max} />)}
      {hidden && (
        <button type="button" className="git-more" onClick={() => setExpanded(true)}>{gitMoreText(repo.branches.length)}</button>
      )}
      {/* Only a list longer than the cap can be over it, and such a list is always collapsed first. */}
      {expanded && repo.unmergedTotal > GIT_BRANCH_CAP && (
        <div className="git-note">{gitNotShownText(repo.unmergedTotal)}</div>
      )}
      {repo.mergedCount > 0 && <div className="git-note">{gitMergedText(repo.mergedCount)}</div>}
    </div>
  );
}
