import type { FetchClock, RepoGitStats } from '../../../../shared/types';
import type { GitSyncControl } from '../../hooks/useGitSync';
import { gitStateSentence } from '../../lib/gitStatsText';
import {
  GitBranchChip, GitBranchList, GitDot, GitFetched, GitSyncButton, GitTrunkChip, GitUncommittedChip, gitGroupsByDir,
} from './GitParts';

/**
 * Cards: one card per repo in pin order, auto-filling columns (two on a laptop, one on a phone). Below `md` the CSS drops the divergence bar and the numbers
 * stay. A non-`ok` repo's card carries its one sentence and nothing else, so broken numbers are never drawn.
 */
export default function GitCards({ repos, sync, clock }: { repos: RepoGitStats[]; sync: GitSyncControl; clock: FetchClock | undefined }) {
  const groups = gitGroupsByDir(repos);
  return (
    <div className="git-cards">
      {repos.map(r => (
        <section key={r.dirName} className="git-card">
          {/* Sync sits beside the wrapping head, not in it, so it stays on the first line however long the name; "fetched" is a fact and ends the facts row. */}
          <div className="git-head-row">
            <div className="git-head">
              <GitDot group={groups.get(r.dirName)} />
              <span className="git-name">{r.name}</span>
              {r.state === 'ok' && <GitBranchChip repo={r} />}
            </div>
            {r.state === 'ok' && <span className="git-head-end"><GitSyncButton repo={r} sync={sync} /></span>}
          </div>
          {r.state === 'ok' ? (
            <>
              <div className="git-facts">
                <GitUncommittedChip repo={r} />
                <GitTrunkChip repo={r} />
                <GitFetched repo={r} clock={clock} />
              </div>
              <GitBranchList repo={r} />
            </>
          ) : (
            <div className="git-state">{gitStateSentence(r)}</div>
          )}
        </section>
      ))}
    </div>
  );
}
