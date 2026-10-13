import { Fragment, useState } from 'react';

import type { FetchClock } from '../../../../shared/types';
import { formatAgo } from '../../lib/format';
import { gitBarMax } from '../../lib/gitBar';
import { isStaleBranch, rankGitRepos, type GitAssessed } from '../../lib/gitLevels';
import { fetchTroubleWord, gitBranchChipText, gitMergedText, gitShownFetchError, gitStateSentence } from '../../lib/gitStatsText';
import type { OkRepo } from '../../lib/gitSync';
import { GitInBranchRow, GitKeys, GitLevelDot, gitTracked } from './GitParts';
import type { GitLayoutProps } from './gitLayoutProps';
import { keyActivate } from '../sessions/atoms';

type Tone = 'ok' | 'bad' | 'meh' | 'live' | 'na';
interface Cell { c: Tone; t: string }
interface CellInput { a: GitAssessed; repo: OkRepo; nowMs: number; clock: FetchClock | undefined }

const NA: Cell = { c: 'na', t: '—' };

const CHECKS: { label: string; cell: (i: CellInput) => Cell }[] = [
  {
    label: 'Working tree',
    // An agent already working on the dirty branch is calm, so the cell is a note, not a failure.
    cell: ({ a, repo }) => {
      if (repo.uncommitted === 0) return { c: 'ok', t: 'clean' };
      return { c: a.problems.find(p => p.k === 'dirty')?.calm ? 'meh' : 'bad', t: `${repo.uncommitted} uncommitted` };
    },
  },
  {
    label: 'Pushed',
    cell: ({ repo }) => {
      if (!repo.hasOrigin) return { c: 'meh', t: 'no remote' };
      const u = gitTracked(repo);
      if (u === null) return NA;
      if (u.counts === null) return { c: 'meh', t: `${u.upstream} gone` };
      if (u.counts.ahead > 0) return { c: 'meh', t: `${u.counts.ahead} unpushed` };
      return { c: 'ok', t: 'yes' };
    },
  },
  {
    label: 'Up to date',
    cell: ({ repo }) => {
      const u = gitTracked(repo);
      if (u === null || u.counts === null) return NA;
      return u.counts.behind > 0 ? { c: 'bad', t: `${u.counts.behind} to pull` } : { c: 'ok', t: 'yes' };
    },
  },
  {
    label: 'Trunk',
    cell: ({ repo }) => {
      const d = repo.trunkVsOrigin;
      if (d === null) return NA;
      if (d.ahead > 0 || d.behind > 0) return { c: 'meh', t: `${repo.trunk}${d.behind ? ` ↓${d.behind}` : ''}${d.ahead ? ` ↑${d.ahead}` : ''}` };
      return { c: 'ok', t: `${repo.trunk} = origin` };
    },
  },
  {
    label: 'Origin data',
    cell: ({ repo, clock }) => {
      if (clock?.runningSinceMs != null && repo.hasOrigin) return { c: 'live', t: 'fetching…' };
      const e = gitShownFetchError(repo);
      if (e !== null) return { c: 'bad', t: `${fetchTroubleWord(e)} · ${repo.fetchedAtMs === null ? 'never' : formatAgo(repo.fetchedAtMs)}` };
      if (repo.fetchedAtMs !== null) return { c: 'ok', t: formatAgo(repo.fetchedAtMs) };
      return { c: 'na', t: 'never' };
    },
  },
  {
    label: 'Branches',
    cell: ({ repo, nowMs }) => {
      const s = repo.branches.filter(b => isStaleBranch(b, nowMs)).length;
      if (s > 0) return { c: 'meh', t: `${repo.unmergedTotal} · ${s} stale` };
      return repo.unmergedTotal > 0 ? { c: 'ok', t: String(repo.unmergedTotal) } : { c: 'na', t: '0' };
    },
  },
];

/**
 * Matrix (management-redesign spec §4.4): a row per repo, a column per check, colour only where a check fails; open one row to read its branches. It is drawn
 * in Sessions › List's table language (the `.ledger` values, ported into `.git-mx`'s own rules): a dot column, name over branch, the whole row the toggle.
 */
export default function GitMatrix(props: GitLayoutProps) {
  const { repos, sessions, nowMs, clock } = props;
  const ranked = rankGitRepos(repos, sessions, nowMs);
  const [row, setRow] = useState<string | null>(null);

  // One pass over the readable repos, so a header count and the cells under it come from the same values.
  const cells = new Map<string, Cell[]>();
  for (const a of ranked) {
    const r = a.repo;
    if (r.state === 'ok') cells.set(r.dirName, CHECKS.map(ch => ch.cell({ a, repo: r, nowMs, clock })));
  }
  const counts = CHECKS.map((_, i) => [...cells.values()].filter(cs => cs[i].c === 'bad' || cs[i].c === 'meh').length);

  return (
    <>
      <div className="git-panel git-mx-wrap">
        <table className="git-mx">
          <thead>
            <tr>
              <th className="git-mx-dot" />
              <th>Repo</th>
              {CHECKS.map((ch, i) => (
                <th key={ch.label}>{ch.label}{counts[i] > 0 && <>{' '}<span className="git-mx-cnt">{counts[i]}</span></>}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {ranked.map(a => {
              const { repo } = a;
              if (repo.state !== 'ok') {
                return (
                  <tr key={repo.dirName} className="off">
                    <td className="git-mx-dot"><GitLevelDot level="dead" /></td>
                    <td className="git-mx-rn"><div className="git-name">{repo.name}</div></td>
                    <td colSpan={CHECKS.length}><span className="git-cell na">{gitStateSentence(repo)}</span></td>
                    <td className="git-mx-act"><GitKeys a={a} ctx={props} bare /></td>
                  </tr>
                );
              }
              const open = row === repo.dirName;
              const toggle = () => setRow(open ? null : repo.dirName);
              const max = gitBarMax(repo.branches);
              const sub = gitBranchChipText(repo);
              return (
                <Fragment key={repo.dirName}>
                  {/* The row is the toggle, as in Sessions › List: a key's click stops at the key, and `keyActivate` ignores Enter / Space aimed at one. */}
                  <tr className="git-mx-r" onClick={toggle} onKeyDown={keyActivate(toggle)} tabIndex={0} aria-expanded={open}>
                    <td className="git-mx-dot"><GitLevelDot level={a.level} /></td>
                    <td className="git-mx-rn">
                      <div className="git-name">{repo.name}</div>
                      <div className="git-mx-sub" title={sub}>{sub}</div>
                    </td>
                    {cells.get(repo.dirName)!.map((v, i) => <td key={CHECKS[i].label}><span className={`git-cell ${v.c}`}>{v.t}</span></td>)}
                    <td className="git-mx-act"><GitKeys a={a} ctx={props} compact /></td>
                  </tr>
                  {open && (
                    <tr className="git-mx-x">
                      <td colSpan={CHECKS.length + 3}>
                        <div className="git-mx-xin">
                          {repo.branches.length === 0
                            ? <span className="git-age">No open branches.</span>
                            : repo.branches.map(b => <GitInBranchRow key={b.name} repo={repo} b={b} max={max} nowMs={nowMs} sessions={sessions} />)}
                          {repo.mergedCount > 0 && <div className="git-age git-mx-note">{gitMergedText(repo.mergedCount)}</div>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="git-mx-legend">
        <span className="git-cell ok">healthy</span>
        <span className="git-cell bad">needs you</span>
        <span className="git-cell meh">worth a look</span>
        <span>— not applicable</span>
        <span>↓ behind · ↑ ahead</span>
      </div>
    </>
  );
}
