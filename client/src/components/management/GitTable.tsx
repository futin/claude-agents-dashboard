import { Fragment, useState } from 'react';

import type { RepoGitStats } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { gitBarMax } from '../../lib/gitBar';
import {
  GIT_BRANCHES_SHOWN, GIT_BRANCH_CAP, GIT_NO_OPEN_BRANCHES,
  gitBranchCounts, gitMergedText, gitMoreText, gitNotShownText, gitStateSentence, gitVisibleBranches,
} from '../../lib/gitStatsText';
import { GitBranchChip, GitDivergenceBar, GitFetched, GitNums, GitTrunkChip, GitUncommittedChip, GitWorktreeBadge, type OkRepo } from './GitParts';

const COLS = 6;

/**
 * Table: one row per repo, columns On / Uncommitted / Trunk vs origin / Branches / Fetched, cells in the copy table's own strings. Clicking an `ok` row opens
 * its branches as sub-rows beneath it. Wide-only (`gitLayoutsFor`): five columns do not survive a phone measure, so a phone is never offered it.
 */
export default function GitTable({ repos }: { repos: RepoGitStats[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (dir: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    return next;
  });

  return (
    <div className="git-table-wrap">
      <table className="git-table">
        <thead>
          <tr><th>Repo</th><th>On</th><th>Uncommitted</th><th>Trunk vs origin</th><th className="n">Branches</th><th>Fetched</th></tr>
        </thead>
        <tbody>
          {repos.map(r => {
            if (r.state !== 'ok') {
              return (
                <tr key={r.dirName} className="git-tr off">
                  <td className="git-tname"><span className="git-caret" />{r.name}</td>
                  <td colSpan={COLS - 1} className="git-state">{gitStateSentence(r)}</td>
                </tr>
              );
            }
            const isOpen = open.has(r.dirName);
            return (
              <Fragment key={r.dirName}>
                <tr className={`git-tr${isOpen ? ' open' : ''}`} onClick={() => toggle(r.dirName)}>
                  <td className="git-tname">
                    {/* The row is the click target; the button is what keyboard and screen readers reach. Its click bubbles to the row, once. */}
                    <button type="button" className="git-rowbtn" aria-expanded={isOpen}>
                      <span className="git-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{r.name}
                    </button>
                  </td>
                  <td><GitBranchChip repo={r} /></td>
                  <td><GitUncommittedChip repo={r} /></td>
                  <td><GitTrunkChip repo={r} /></td>
                  <td className="n">{r.unmergedTotal}</td>
                  <td><GitFetched repo={r} /></td>
                </tr>
                {isOpen && <GitSubRows repo={r} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One expanded repo's branches as sub-rows, with the same "+N more" / over-cap / merged lines the shared list draws. */
function GitSubRows({ repo }: { repo: OkRepo }) {
  const [expanded, setExpanded] = useState(false);
  const max = gitBarMax(repo.branches);
  return (
    <>
      {repo.branches.length === 0 && (
        <tr className="git-sub"><td colSpan={COLS} className="git-note">{GIT_NO_OPEN_BRANCHES}</td></tr>
      )}
      {gitVisibleBranches(repo.branches, expanded).map(b => {
        const c = gitBranchCounts(b);
        return (
          <tr key={b.name} className="git-sub">
            {/* The name borrows the On column rather than widening Repo; the age stays under Fetched. */}
            <td colSpan={2}><span className="git-bname"><span className="git-bname-t">{b.name}</span><GitWorktreeBadge b={b} /></span></td>
            <td colSpan={COLS - 3}>
              {c && <span className="git-div"><GitDivergenceBar ahead={c.ahead} behind={c.behind} max={max} /><GitNums ahead={c.ahead} behind={c.behind} /></span>}
            </td>
            <td className="git-age">{formatAgo(b.lastCommitMs)}</td>
          </tr>
        );
      })}
      {repo.branches.length > GIT_BRANCHES_SHOWN && !expanded && (
        <tr className="git-sub">
          <td colSpan={COLS}>
            <button type="button" className="git-more" onClick={() => setExpanded(true)}>{gitMoreText(repo.branches.length)}</button>
          </td>
        </tr>
      )}
      {expanded && repo.unmergedTotal > GIT_BRANCH_CAP && (
        <tr className="git-sub"><td colSpan={COLS} className="git-note">{gitNotShownText(repo.unmergedTotal)}</td></tr>
      )}
      {repo.mergedCount > 0 && (
        <tr className="git-sub"><td colSpan={COLS} className="git-note">{gitMergedText(repo.mergedCount)}</td></tr>
      )}
    </>
  );
}
