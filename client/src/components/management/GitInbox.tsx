import { useState } from 'react';

import { formatAgo } from '../../lib/format';
import { GIT_LEVELS, agentOn, gitPlural, gitSentence, rankGitRepos, type GitAssessed, type GitLevel } from '../../lib/gitLevels';
import { GIT_BRANCH_CAP, gitBranchChipText, gitFetchedText, gitNotShownText, gitStateSentence } from '../../lib/gitStatsText';
import { GitAgentChip, GitBranchChip, GitBranchDv, GitBranchLabel, GitKeys, GitLevelDot } from './GitParts';
import type { GitLayoutProps } from './gitLayoutProps';
import Chevron from '../Chevron';

/**
 * Inbox (management-redesign spec §4.3): four count tiles that filter, then one ranked list. Repos that need a look get a full item with a verdict, the
 * further problems as steps and their keys; quiet and unreadable ones collapse to a line each, so the loud ones are all the eye has to find.
 */
export default function GitInbox(props: GitLayoutProps) {
  const { repos, sessions, nowMs, clock } = props;
  const ranked = rankGitRepos(repos, sessions, nowMs);
  const [filter, setFilter] = useState<GitLevel | 'all'>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const show = (l: GitLevel) => filter === 'all' || filter === l;
  const toggle = (dirName: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(dirName)) next.add(dirName);
    return next;
  });

  const loud = ranked.filter(a => (a.level === 'needs' || a.level === 'look') && show(a.level));
  const quiet = ranked.filter(a => a.level === 'quiet' && show('quiet'));
  const dead = ranked.filter(a => a.level === 'dead' && show('dead'));

  return (
    <>
      <div className="git-ib-sum">
        {GIT_LEVELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`git-ib-tile ${key}${filter === key ? ' on' : ''}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(filter === key ? 'all' : key)}
          >
            <span className="big">{ranked.filter(a => a.level === key).length}</span>
            <span className="lab"><GitLevelDot level={key} />{label}</span>
          </button>
        ))}
      </div>
      {loud.length > 0 && (
        <div className="git-ib-list">
          {loud.map(a => <InboxItem key={a.repo.dirName} a={a} ctx={props} isOpen={open.has(a.repo.dirName)} onToggle={() => toggle(a.repo.dirName)} />)}
        </div>
      )}
      {quiet.length > 0 && (
        <>
          <div className="git-gh">All good</div>
          <div className="git-ib-quiet">
            {quiet.map(a => a.repo.state === 'ok' && (
              <div key={a.repo.dirName} className="git-ib-line">
                <GitLevelDot level="quiet" />
                <span className="git-name">{a.repo.name}</span>
                <span className="git-ib-facts">{[gitBranchChipText(a.repo), ...a.problems.filter(p => p.k !== 'detached').map(p => p.short), gitFetchedText(a.repo, clock).text].join(' · ')}</span>
                <GitKeys a={a} ctx={props} bare />
              </div>
            ))}
          </div>
        </>
      )}
      {dead.length > 0 && (
        <>
          <div className="git-gh">Can't read</div>
          <div className="git-ib-quiet">
            {dead.map(a => a.repo.state !== 'ok' && (
              <div key={a.repo.dirName} className="git-ib-line">
                <GitLevelDot level="dead" />
                <span className="git-name">{a.repo.name}</span>
                <span className="git-ib-facts">{gitStateSentence(a.repo)}</span>
                <GitKeys a={a} ctx={props} bare />
              </div>
            ))}
          </div>
        </>
      )}
      {loud.length + quiet.length + dead.length === 0 && filter !== 'all' && <div className="git-empty">No repo at this level.</div>}
    </>
  );
}

function InboxItem({ a, ctx, isOpen, onToggle }: { a: GitAssessed; ctx: GitLayoutProps; isOpen: boolean; onToggle: () => void }) {
  const { repo, problems } = a;
  // A loud level is always an ok repo; the guard narrows the union for the branch fields.
  if (repo.state !== 'ok') return null;
  const mergedCount = repo.mergedCount;
  return (
    <article className="git-panel git-ib-item">
      <div className="git-ib-top">
        <GitLevelDot level={a.level} />
        <div className="git-ib-main">
          <div className="git-head">
            <span className="git-name">{repo.name}</span>
            <GitBranchChip repo={repo} />
            <GitAgentChip agent={agentOn(repo, repo.branch, ctx.sessions)} />
          </div>
          <div className="git-ib-verdict">{gitSentence(problems[0].text)}</div>
          {problems.length > 1 && (
            <ul className="git-ib-steps">
              {problems.slice(1).map(p => <li key={p.k} className={p.calm ? 'calm' : p.sev >= 3 ? 'hot' : undefined}>{p.text}</li>)}
            </ul>
          )}
        </div>
        <div className="git-ib-keys"><GitKeys a={a} ctx={ctx} /></div>
      </div>
      {repo.unmergedTotal > 0 && (
        <div className="git-ib-br">
          <button type="button" className="git-ib-tog" aria-expanded={isOpen} onClick={onToggle}>
            <span className="git-caret" aria-hidden="true"><Chevron dir={isOpen ? 'down' : 'right'} /></span>
            {gitPlural(repo.unmergedTotal, 'open branch')}
            {mergedCount > 0 && ` · ${mergedCount} merged hidden`}
          </button>
          {isOpen && (
            <>
              {repo.branches.map(b => (
                <div key={b.name} className="git-ib-brow">
                  <GitBranchLabel repo={repo} b={b} sessions={ctx.sessions} />
                  <GitBranchDv b={b} />
                  <span className="git-age">{formatAgo(b.lastCommitMs)}</span>
                </div>
              ))}
              {repo.unmergedTotal > GIT_BRANCH_CAP && <div className="git-ib-brow git-age">{gitNotShownText(repo.unmergedTotal)}</div>}
            </>
          )}
        </div>
      )}
    </article>
  );
}
