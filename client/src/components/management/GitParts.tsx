import { useState } from 'react';

import type { FetchClock, GitBranch, RepoGitStats, Session } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { gitBarMax, gitBarWidth } from '../../lib/gitBar';
import {
  GIT_BRANCHES_SHOWN, GIT_BRANCH_CAP, GIT_NO_OPEN_BRANCHES,
  gitBranchChipText, gitBranchCounts, gitFetchedText, gitMergedText, gitMoreText, gitNotShownText, gitTrunkVsOriginText, gitUncommittedText,
  gitUpstreamShown, gitUpstreamText, gitVisibleBranches,
} from '../../lib/gitStatsText';
import { triageGitRepos, type GitTriageGroup } from '../../lib/gitTriage';

/**
 * The pieces every Git layout shares (spec §6 "Shared repo facts"): the status dot, the repo-level chips, the divergence bar and the branch list with its
 * "+N more" / merged lines. The three layouts differ only in how they arrange these.
 */

import type { GitSyncControl } from '../../hooks/useGitSync';
import { GIT_LEVEL_DOT, agentOn, type GitAgent, type GitAssessed, type GitLevel } from '../../lib/gitLevels';
import { canSync, syncKeyLabel, type OkRepo } from '../../lib/gitSync';
import type { GitLayoutProps } from './gitLayoutProps';

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

/** The current branch against its upstream; nothing when level, absent or tracking `origin/<trunk>`. Mustard only when behind. */
export function GitUpstreamChip({ repo }: { repo: OkRepo }) {
  const text = gitUpstreamText(repo);
  if (text === null) return null;
  const behind = (gitUpstreamShown(repo)?.counts?.behind ?? 0) > 0;
  return <span className={`git-chip${behind ? ' mustard' : ''}`}>{text}</span>;
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

/** The age alone when the last fetch went fine; the server's verdict in amber when it did not; cyan "fetching…" while one runs. */
export function GitFetched({ repo, clock }: { repo: OkRepo; clock: FetchClock | undefined }) {
  const { text, tone } = gitFetchedText(repo, clock);
  return <span className={`git-fetched${tone ? ` ${tone}` : ''}`}>{text}</span>;
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

/** Two arrows chasing, not the band's ↻: that one re-reads the stats, this one spends a session. Turns while a sync runs (`.git-sync.on`). */
function GitSyncGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9M2.5 8a5.5 5.5 0 0 1 9.4-3.9" />
      <path d="M12 1.5v3h-3M4 14.5v-3h3" />
    </svg>
  );
}

/**
 * The repo's Sync button (spec §9): a raised key, square where the fact chips are round, so the two never read alike. Nothing while the host cannot spawn
 * or git-sync would refuse the repo. Idle it launches; running it opens the chat; launching, unseen or mid-POST it is disabled. Its click never bubbles, so
 * the Table row it sits in does not toggle.
 */
export function GitSyncButton({ repo, sync, verbs, primary, label }: {
  repo: RepoGitStats;
  sync: GitSyncControl;
  verbs?: readonly string[];
  primary?: boolean;
  label?: string;
}) {
  if (!sync.available || !canSync(repo)) return null;
  // `canSync` narrowed `repo` to an ok one, so `toplevel` is there.
  const phase = sync.phaseFor(repo);
  const running = phase?.kind === 'running' ? phase : null;
  const idle = phase === null || phase.kind === 'ended' || phase.kind === 'failed';
  return (
    <button
      type="button"
      className={`git-sync${running ? ' on' : primary ? ' primary' : ''}`}
      disabled={!running && (!idle || sync.pending)}
      aria-label={running ? `Open the git-sync chat for ${repo.name}` : `Sync ${repo.name}`}
      onClick={e => {
        e.stopPropagation();
        if (running) sync.openChat(running.session.id);
        else sync.start(repo);
      }}
    >
      <GitSyncGlyph />
      {syncKeyLabel(phase, sync.starting === repo.toplevel, { verbs, label })}
    </button>
  );
}

/* The parts of Inbox | Matrix | Inspector | Branches (management-redesign spec §4.2). */

export function GitLevelDot({ level }: { level: GitLevel }) {
  return <span className={`git-dot ${GIT_LEVEL_DOT[level]}`} aria-hidden="true" />;
}

export function GitAgentChip({ agent }: { agent: GitAgent | null }) {
  return agent ? <span className={`git-sess ${agent.kind}`}>{agent.label}</span> : null;
}

/** Behind then ahead as words-free arrows; a zero is muted so the eye lands on the side that has something. */
export function GitDv({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <span className="git-dv" aria-label={`${behind} behind, ${ahead} ahead`}>
      <span className={behind ? 'b' : 'z'}>↓{behind}</span>
      <span className={ahead ? 'a' : 'z'}>↑{ahead}</span>
    </span>
  );
}

/** The bar half is 56px, matching `.git-dvbar`'s grid columns. */
export function GitDvBar({ ahead, behind, max }: { ahead: number; behind: number; max: number }) {
  return (
    <span className="git-dvbar" aria-hidden="true">
      <i className="bb" style={{ width: gitBarWidth(behind, max, 56) }} />
      <i className="bc" />
      <i className="ba" style={{ width: gitBarWidth(ahead, max, 56) }} />
    </span>
  );
}

export function GitBranchDv({ b }: { b: GitBranch }) {
  const c = gitBranchCounts(b);
  return c ? <GitDv ahead={c.ahead} behind={c.behind} /> : <span className="git-dv"><span className="z">—</span></span>;
}

/** The count-less case keeps the element so the grid column and the phone rule that hides the bar still apply. */
export function GitBranchDvBar({ b, max }: { b: GitBranch; max: number }) {
  const c = gitBranchCounts(b);
  return c ? <GitDvBar ahead={c.ahead} behind={c.behind} max={max} /> : <span className="git-dvbar" aria-hidden="true" />;
}

export function GitBranchLabel({ repo, b, sessions }: { repo: RepoGitStats; b: GitBranch; sessions: readonly Session[] }) {
  return (
    <span className="git-bname">
      <span className="git-bname-t">{b.name}</span>
      <GitWorktreeBadge b={b} />
      <GitAgentChip agent={agentOn(repo, b.name, sessions)} />
    </span>
  );
}

/**
 * The action keys of a repo, shared by every layout. `bare` drops the primary styling and the verb list (a row that already carries its own call to action),
 * `compact` shortens Retry and lets Sync take the primary only for a repo that needs you. A dead repo gets Unpin and nothing else.
 */
export function GitKeys({ a, ctx, bare = false, compact = false }: { a: GitAssessed; ctx: GitLayoutProps; bare?: boolean; compact?: boolean }) {
  if (a.level === 'dead') {
    return (
      <button
        type="button"
        className={`git-key${bare ? '' : ' primary'}`}
        disabled={ctx.unpin.busy !== null}
        onClick={e => {
          e.stopPropagation();
          ctx.unpin.run(a.repo.dirName);
        }}
      >
        {ctx.unpin.busy === a.repo.dirName ? 'Unpinning…' : 'Unpin'}
      </button>
    );
  }
  const retry = a.problems.some(p => p.k === 'fetch');
  const retryPrimary = compact ? a.level === 'needs' : !bare;
  const syncPrimary = compact ? !retry && a.level === 'needs' : !bare && !retry && a.level !== 'quiet' && a.verbs.length > 0;
  return (
    <>
      {retry && (
        <button
          type="button"
          className={`git-key${retryPrimary ? ' primary' : ''}`}
          disabled={ctx.fetchCtl.pending || ctx.clock?.runningSinceMs != null || (ctx.sync.tokenRequired === true && !ctx.fetchCtl.tokenStored)}
          onClick={e => {
            e.stopPropagation();
            ctx.fetchCtl.start();
          }}
        >
          {compact ? 'Retry' : 'Retry fetch'}
        </button>
      )}
      <GitSyncButton repo={a.repo} sync={ctx.sync} verbs={bare || compact ? [] : a.verbs} primary={syncPrimary} />
    </>
  );
}
