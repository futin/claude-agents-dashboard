import type { GitBranch, RepoGitStats, Session } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { gitBarWidth } from '../../lib/gitBar';
import { gitBranchChipText, gitBranchCounts } from '../../lib/gitStatsText';

import type { GitSyncControl } from '../../hooks/useGitSync';
import { GIT_LEVEL_DOT, agentOn, isStaleBranch, type GitAgent, type GitAssessed, type GitLevel } from '../../lib/gitLevels';
import { canSync, syncKeyLabel, type OkRepo } from '../../lib/gitSync';
import type { GitLayoutProps } from './gitLayoutProps';

/**
 * The pieces the four Git layouts (Inbox, Matrix, Inspector, Branches) share: the level dot, agent chip, divergence figures and bar, the branch label and row,
 * and the action keys. The layouts differ only in how they arrange these.
 */

export type { OkRepo };

export function GitBranchChip({ repo }: { repo: OkRepo }) {
  return <span className="git-chip branch">{gitBranchChipText(repo)}</span>;
}

export function GitWorktreeBadge({ b }: { b: GitBranch }) {
  return b.worktreePath === null ? null : <span className="git-chip wt">worktree</span>;
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
 * a clickable row it sits in does not toggle.
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
          disabled={ctx.fetchCtl.pending || ctx.clock?.runningSinceMs != null || ctx.sync.writeAccess === 'none' || (ctx.sync.tokenRequired === true && !ctx.fetchCtl.tokenStored)}
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

/**
 * The branch's upstream, unless it is absent or is `origin/<trunk>` itself, whose numbers the Trunk column already carries. Unlike `gitUpstreamShown`, a
 * level (0 / 0) upstream stays: Matrix's Pushed and Up to date cells and Inspector's list figure read it.
 */
export function gitTracked(r: OkRepo): NonNullable<OkRepo['currentVsUpstream']> | null {
  const u = r.currentVsUpstream ?? null;
  if (u === null || (r.trunk !== null && u.upstream === `origin/${r.trunk}`)) return null;
  return u;
}

/** One branch as a `.git-in-br` row, shared by Matrix's expanded row and Inspector's two sections; a stale one reads quieter. */
export function GitInBranchRow({ repo, b, max, nowMs, sessions }: { repo: OkRepo; b: GitBranch; max: number; nowMs: number; sessions: readonly Session[] }) {
  return (
    <div className={`git-in-br${isStaleBranch(b, nowMs) ? ' stale' : ''}`}>
      <GitBranchLabel repo={repo} b={b} sessions={sessions} />
      <GitBranchDvBar b={b} max={max} />
      <GitBranchDv b={b} />
      <span className="git-age">{formatAgo(b.lastCommitMs)}</span>
    </div>
  );
}
