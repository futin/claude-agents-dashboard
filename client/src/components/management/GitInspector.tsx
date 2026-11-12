import { useRef, useState, type KeyboardEvent } from 'react';

import { formatAgo } from '../../lib/format';
import { gitBarMax } from '../../lib/gitBar';
import { originData, stateCheck, trunk, workingTree, yourBranch, type GitCheck } from '../../lib/gitChecks';
import { GIT_LEVEL_STATUS, agentOn, gitPlural, isStaleBranch, rankGitRepos, type GitAssessed } from '../../lib/gitLevels';
import { gitBranchChipText, gitFetchedText } from '../../lib/gitStatsText';
import type { OkRepo } from '../../lib/gitSync';
import { GitDv, GitInBranchRow, GitKeys, GitLevelDot, GitSyncButton, gitTracked } from './GitParts';
import type { GitLayoutProps } from './gitLayoutProps';

/**
 * Inspector (management-redesign spec §4.5): the Sessions split, a ranked list of repos beside one repo in depth. The picked repo is whichever the list last
 * chose, falling back to the top-ranked one when it leaves the list; on a narrow window the pane stacks under the list, so a pick scrolls it into view.
 */
export default function GitInspector(props: GitLayoutProps) {
  const { repos, sessions, nowMs, clock, narrow } = props;
  const ranked = rankGitRepos(repos, sessions, nowMs);
  const [pick, setPick] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const cur = ranked.find(x => x.repo.dirName === pick) ?? ranked[0];

  const choose = (dirName: string) => {
    setPick(dirName);
    if (narrow) paneRef.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const onKey = (e: KeyboardEvent, dirName: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    choose(dirName);
  };

  return (
    <div className="split git-in">
      <div className="s-card list">
        <div className="list-h"><span className="ct">Repos</span><span className="proj-pill">{ranked.length}</span></div>
        {ranked.map(a => {
          const { repo, level, problems } = a;
          const selected = repo.dirName === cur.repo.dirName;
          const counts = repo.state === 'ok' ? gitTracked(repo)?.counts ?? null : null;
          const why = level === 'quiet' ? problems[0]?.short ?? 'clean · in step' : problems[0].text;
          const fetched = repo.state === 'ok' ? gitFetchedText(repo, clock) : null;
          const agoText = repo.state === 'ok' ? (fetched?.tone === 'live' ? 'fetching…' : repo.fetchedAtMs === null ? 'never' : formatAgo(repo.fetchedAtMs)) : '';
          return (
            <div
              key={repo.dirName}
              className={`lrow${selected ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={() => choose(repo.dirName)}
              onKeyDown={e => onKey(e, repo.dirName)}
            >
              <GitLevelDot level={level} />
              <span className="nm"><span className="t">{repo.name}</span>{repo.state === 'ok' && <span className="proj-pill">{gitBranchChipText(repo)}</span>}</span>
              <span className="pct git-in-fig">{counts ? <GitDv {...counts} /> : null}</span>
              <div className="act-line">
                <span className={`spill g-${level}`}>{GIT_LEVEL_STATUS[level]}</span>
                <span>·</span>
                <span className={`act${level === 'needs' ? ' hot' : ''}`}>{why}</span>
                {repo.state === 'ok' && <span className={`ago${fetched?.tone ? ` ${fetched.tone}` : ''}`}>{agoText}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="s-card inspect git-in-pane" ref={paneRef}>
        {cur && <Pane a={cur} ctx={props} />}
      </div>
    </div>
  );
}

function Pane({ a, ctx }: { a: GitAssessed; ctx: GitLayoutProps }) {
  const { repo, level } = a;
  const { sessions, nowMs, clock, sync } = ctx;
  const ok = repo.state === 'ok' ? repo : null;
  const checks: GitCheck[] = ok
    ? [workingTree(a, ok, agentOn(ok, ok.branch, sessions) !== null), yourBranch(ok), trunk(ok), originData(ok, clock)]
    : [stateCheck(repo as Exclude<GitAssessed['repo'], OkRepo>)];
  const listed = ok ? ok.branches : [];
  const act = listed.filter(b => !isStaleBranch(b, nowMs));
  const st = listed.filter(b => isStaleBranch(b, nowMs));
  const max = gitBarMax(listed);
  const merged = ok?.mergedCount ?? 0;
  const footText = [merged > 0 && `${gitPlural(merged, 'merged branch')} can be deleted.`, st.length > 0 && `${gitPlural(st.length, 'stale branch')} to review.`].filter(Boolean).join(' ');

  return (
    <>
      <div className="ins-head">
        <div className="who2">
          <div className="ct">{repo.name}</div>
          <div className="ins-meta">
            <GitLevelDot level={level} />
            <span className={`spill g-${level}`}>{GIT_LEVEL_STATUS[level]}</span>
            {ok && <span className="proj-pill">{gitBranchChipText(ok)}</span>}
            <span className="git-in-path">{repo.path ?? ''}</span>
          </div>
        </div>
        {ok && ok.path !== null && <button type="button" className="git-key" onClick={() => ctx.openFolder(ok.path!)}>Open folder</button>}
        <GitKeys a={a} ctx={ctx} />
      </div>
      <div className="git-in-checks">
        {checks.map(c => (
          <div key={c.k} className={`kv git-in-ck ${c.c}`}>
            <span className="k">{c.k}</span>
            <span className="v">{c.v}</span>
            {c.h && <span className="h">{c.h}</span>}
          </div>
        ))}
      </div>
      {ok && (
        <>
          <div className="git-in-sec">
            <div className="git-in-hd"><b>Active branches</b><span>{`${act.length} · ↓ behind ${ok.trunk ?? 'base'} · ↑ ahead`}</span></div>
            {act.length > 0
              ? act.map(b => <GitInBranchRow key={b.name} repo={ok} b={b} max={max} nowMs={nowMs} sessions={sessions} />)
              : <div className="git-age git-in-none">None.</div>}
          </div>
          {st.length > 0 && (
            <div className="git-in-sec">
              <div className="git-in-hd"><b>Stale</b><span>{`${st.length} · ≥ 20 behind or idle a week`}</span></div>
              {st.map(b => <GitInBranchRow key={b.name} repo={ok} b={b} max={max} nowMs={nowMs} sessions={sessions} />)}
            </div>
          )}
          {(st.length > 0 || merged > 0) && (
            <div className="git-in-foot">
              <span>{footText}</span>
              <GitSyncButton repo={ok} sync={sync} label="Clean up via Sync" />
            </div>
          )}
        </>
      )}
    </>
  );
}
