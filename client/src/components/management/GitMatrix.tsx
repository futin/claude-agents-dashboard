import { Fragment, useState } from 'react';

import { gitBarMax } from '../../lib/gitBar';
import { rankGitRepos } from '../../lib/gitLevels';
import { MATRIX_COLUMNS, matrixCells, matrixHeaderCount, matrixRowHasWork, type MatrixCell } from '../../lib/gitMatrixCells';
import { gitBranchChipText, gitMergedText, gitStateSentence } from '../../lib/gitStatsText';
import { GitInBranchRow, GitKeys, GitLevelDot } from './GitParts';
import type { GitLayoutProps } from './gitLayoutProps';
import { keyActivate } from '../sessions/atoms';

/**
 * Matrix (management-redesign spec §4.4): a row per repo, a column per check, colour only where Sync has work; open one row to read its branches. It is drawn
 * in Sessions › List's table language (the `.ledger` values, ported into `.git-mx`'s own rules): a dot column, name over branch, the whole row the toggle.
 */
export default function GitMatrix(props: GitLayoutProps) {
  const { repos, sessions, nowMs, clock } = props;
  const ranked = rankGitRepos(repos, sessions, nowMs);
  const [row, setRow] = useState<string | null>(null);

  // One pass over the readable repos, so a header count and the cells under it come from the same values.
  const cells = new Map<string, MatrixCell[]>();
  for (const a of ranked) {
    const r = a.repo;
    if (r.state === 'ok') cells.set(r.dirName, matrixCells({ a, repo: r, nowMs, clock }));
  }
  const counts = MATRIX_COLUMNS.map((_, i) => matrixHeaderCount([...cells.values()].filter(cs => cs[i].c === 'bad' || cs[i].c === 'meh').length));

  return (
    <>
      <div className="git-panel git-mx-wrap">
        <table className="git-mx">
          <thead>
            <tr>
              <th className="git-mx-dot" />
              <th>Repo</th>
              {MATRIX_COLUMNS.map((label, i) => (
                <th key={label}>{label}{counts[i] !== '' && <span className="git-mx-cnt">{counts[i]}</span>}</th>
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
                    <td colSpan={MATRIX_COLUMNS.length}><span className="git-cell na">{gitStateSentence(repo)}</span></td>
                    <td className="git-mx-act"><GitKeys a={a} ctx={props} bare /></td>
                  </tr>
                );
              }
              const open = row === repo.dirName;
              const toggle = () => setRow(open ? null : repo.dirName);
              const max = gitBarMax(repo.branches);
              const sub = gitBranchChipText(repo);
              const rowCells = cells.get(repo.dirName)!;
              return (
                <Fragment key={repo.dirName}>
                  {/* The row is the toggle, as in Sessions › List: a key's click stops at the key, and `keyActivate` ignores Enter / Space aimed at one. */}
                  <tr className="git-mx-r" onClick={toggle} onKeyDown={keyActivate(toggle)} tabIndex={0} aria-expanded={open}>
                    <td className="git-mx-dot"><GitLevelDot level={a.level} /></td>
                    <td className="git-mx-rn">
                      <div className="git-name">{repo.name}</div>
                      <div className="git-mx-sub" title={sub}>{sub}</div>
                    </td>
                    {rowCells.map((v, i) => (
                      <td key={MATRIX_COLUMNS[i]}>
                        <span className={`git-cell ${v.c}`}>{v.t}</span>
                        {v.note !== undefined && <span className="git-cell-note"> · {v.note}</span>}
                      </td>
                    ))}
                    <td className="git-mx-act"><GitKeys a={a} ctx={props} compact work={matrixRowHasWork(rowCells)} /></td>
                  </tr>
                  {open && (
                    <tr className="git-mx-x">
                      <td colSpan={MATRIX_COLUMNS.length + 3}>
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
        <span className="git-cell bad">needs you</span>
        <span className="git-cell meh">Sync will handle it</span>
        <span className="git-cell ok">nothing to do</span>
        <span>Sync key turns amber whenever any cell in the row has work</span>
        <span>Header line counts repos, not branches</span>
      </div>
    </>
  );
}
