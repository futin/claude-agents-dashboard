import { formatAgo } from '../../lib/format';
import { agentOn, assessGitRepo, isStaleBranch } from '../../lib/gitLevels';
import { gitCompareUrl } from '../../lib/gitLinks';
import { fetchTroubleWord, gitShownFetchError } from '../../lib/gitStatsText';
import type { OkRepo } from '../../lib/gitSync';
import { GitAgentChip, GitBranchDv, GitSyncButton, GitWorktreeBadge } from './GitParts';
import type { GitLayoutProps } from './gitLayoutProps';

type Col = 'agent' | 'ready' | 'drift' | 'stale';

const COLS: { key: Col; label: string; hint: string }[] = [
  { key: 'agent', label: 'Agent on it', hint: 'a live session has it checked out' },
  { key: 'ready', label: 'Ready', hint: '0 behind trunk, nothing to rebase' },
  { key: 'drift', label: 'Drifting', hint: 'behind trunk, still recent' },
  { key: 'stale', label: 'Stale', hint: '≥ 20 behind or idle a week' },
];

/**
 * Branches (management-redesign spec §4.6): every open branch across the pins, a column per need. Repos keep pin order since nothing here is ranked; a repo
 * that cannot be read has no branches to place, so it gets a note that points at Inbox instead of a column.
 */
export default function GitBranches({ repos, sessions, nowMs, sync, quick, setLayout }: GitLayoutProps) {
  const assessed = repos.map(r => assessGitRepo(r, sessions, nowMs));
  const items: { col: Col; repo: OkRepo; b: OkRepo['branches'][number]; a: (typeof assessed)[number] }[] = [];
  for (const a of assessed) {
    if (a.repo.state !== 'ok') continue;
    const repo = a.repo;
    for (const b of repo.branches) {
      const col: Col = agentOn(repo, b.name, sessions) ? 'agent' : isStaleBranch(b, nowMs) ? 'stale' : b.behind === 0 ? 'ready' : 'drift';
      items.push({ col, repo, b, a });
    }
  }
  const off = assessed.filter(a => a.repo.state !== 'ok');

  return (
    <>
      <div className="git-bb-cols">
        {COLS.map(c => {
          const mine = items.filter(i => i.col === c.key);
          return (
            <div key={c.key} className="git-bb-col">
              <div className="git-bb-ch"><b>{c.label}</b> <span className="git-age">{mine.length}</span><span className="git-bb-hint">{c.hint}</span></div>
              {mine.length === 0 && <div className="git-bb-empty">Nothing here.</div>}
              {mine.map(({ repo, b, a }) => {
                const here = repo.branch === b.name;
                const agent = agentOn(repo, b.name, sessions);
                const e = gitShownFetchError(repo);
                const url = c.key === 'ready' ? gitCompareUrl(repo.originUrl ?? null, repo.trunk, b.name) : null;
                const probs = a.problems.filter(p => p.k === 'dirty' || p.k === 'push' || p.k === 'pull');
                return (
                  <div key={`${repo.dirName}\0${b.name}`} className={`git-panel git-bb-card${c.key === 'stale' ? ' stale' : ''}`}>
                    <span className="git-bb-bn">{b.name}</span>
                    <span className="git-bb-ln"><span className="git-bb-repo">{repo.name}</span><GitWorktreeBadge b={b} /></span>
                    <span className="git-bb-ln"><GitBranchDv b={b} /><span className="git-age">{formatAgo(b.lastCommitMs)}</span></span>
                    {here && (
                      <span className="git-bb-ln start">
                        <span className="git-chip">checked out</span>
                        {probs.map(p => <span key={p.k} className={`git-chip ${p.calm ? 'dim' : p.sev >= 3 ? 'amber' : 'mustard'}`}>{p.short}</span>)}
                      </span>
                    )}
                    {e !== null && (
                      <span className="git-bb-warn">
                        {`${fetchTroubleWord(e)} · ` + (repo.fetchedAtMs === null ? 'origin never fetched' : `origin ${formatAgo(repo.fetchedAtMs)} old`)}
                      </span>
                    )}
                    {agent && <span className="git-bb-ln start"><GitAgentChip agent={agent} /></span>}
                    {(here || url !== null) && (
                      <span className="git-bb-ln end">
                        {here && <GitSyncButton repo={repo} sync={sync} quick={quick} />}
                        {url !== null && <a className="git-key" href={url} target="_blank" rel="noopener noreferrer">Open PR</a>}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {off.length > 0 && (
        <div className="git-bb-note">
          {`Not on the board: ${off.map(a => `${a.repo.name} (${a.problems[0].short})`).join(', ')}. `}
          <button type="button" className="git-link" onClick={() => setLayout('inbox')}>Open Inbox</button>
        </div>
      )}
    </>
  );
}
