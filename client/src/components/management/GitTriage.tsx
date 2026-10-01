import { useState } from 'react';

import type { RepoGitStats } from '../../../../shared/types';
import { gitBranchChipText, gitFetchedText, gitStateSentence, gitTrunkVsOriginText, gitUncommittedText } from '../../lib/gitStatsText';
import { triageGitRepos, type GitTriageGroup } from '../../lib/gitTriage';
import { GitBranchChip, GitBranchList, GitDot, GitFetched, GitSyncButton, GitTrunkChip, GitUncommittedChip, type OkRepo } from './GitParts';
import type { GitSyncControl } from '../../hooks/useGitSync';

/** Drawn in this order, Can't read last; an empty group draws nothing, header included. */
const GROUPS: { key: GitTriageGroup; label: string }[] = [
  { key: 'needs', label: 'Needs you' },
  { key: 'flight', label: 'In flight' },
  { key: 'quiet', label: 'Quiet' },
  { key: 'unreadable', label: "Can't read" },
];

/**
 * Triage: repos grouped by `triageGitRepos`, pin order kept inside each group. Needs you and In flight rows open with their branches; Quiet rows are one
 * dashed line each that expands on click; Can't read rows are one muted line with their sentence.
 */
export default function GitTriage({ repos, sync }: { repos: RepoGitStats[]; sync: GitSyncControl }) {
  const groups = triageGitRepos(repos);
  return (
    <div className="git-tri">
      {GROUPS.filter(g => groups[g.key].length > 0).map(g => (
        <div key={g.key} className="git-tri-group">
          <div className="git-tri-h">{g.label}</div>
          {groups[g.key].map(r => {
            if (r.state !== 'ok') return <GitUnreadableRow key={r.dirName} repo={r} />;
            return g.key === 'quiet'
              ? <GitQuietRow key={r.dirName} repo={r} sync={sync} />
              : <GitBusyRow key={r.dirName} repo={r} group={g.key} sync={sync} />;
          })}
        </div>
      ))}
    </div>
  );
}

function GitBusyRow({ repo, group, sync }: { repo: OkRepo; group: GitTriageGroup; sync: GitSyncControl }) {
  return (
    <section className="git-arow">
      <div className="git-head">
        <GitDot group={group} />
        <span className="git-name">{repo.name}</span>
        <GitBranchChip repo={repo} />
        <GitUncommittedChip repo={repo} />
        <GitTrunkChip repo={repo} />
        <span className="git-head-end">
          <GitFetched repo={repo} />
          <GitSyncButton repo={repo} sync={sync} />
        </span>
      </div>
      <GitBranchList repo={repo} />
    </section>
  );
}

function GitQuietRow({ repo, sync }: { repo: OkRepo; sync: GitSyncControl }) {
  const [open, setOpen] = useState(false);
  const summary = [gitBranchChipText(repo), gitUncommittedText(repo.uncommitted), gitTrunkVsOriginText(repo), gitFetchedText(repo.fetchedAtMs)].join(' · ');
  return (
    <section className={`git-arow quiet${open ? ' open' : ''}`}>
      {/* A button cannot hold a button, so Sync sits beside the row toggle, not inside it. */}
      <div className="git-qhead">
        <button type="button" className="git-head git-rowbtn" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <GitDot group="quiet" />
          <span className="git-name">{repo.name}</span>
          <span className="git-summary">{summary}</span>
          <span className="git-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        <GitSyncButton repo={repo} sync={sync} />
      </div>
      {open && <GitBranchList repo={repo} />}
    </section>
  );
}

function GitUnreadableRow({ repo }: { repo: Exclude<RepoGitStats, { state: 'ok' }> }) {
  return (
    <section className="git-arow quiet unreadable">
      <div className="git-head">
        <GitDot group="unreadable" />
        <span className="git-name">{repo.name}</span>
        <span className="git-summary">{gitStateSentence(repo)}</span>
      </div>
    </section>
  );
}
