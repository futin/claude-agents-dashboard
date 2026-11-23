import { Fragment } from 'react';

import type { CodegraphAssessed } from '../../lib/codegraphLevels';
import { codegraphChecks, type CodegraphCell } from '../../lib/codegraphMatrixCells';
import { CODEGRAPH_FOLDER_GONE, MATRIX_COLUMNS, MATRIX_NOT_INDEXED, compactCount, formatDbSize, fullCount, indexedAge } from '../../lib/codegraphText';
import { CodegraphConfirm, CodegraphDot, CodegraphKeys, type CodegraphLayoutProps } from './CodegraphParts';

const COLUMNS = 12;

function CellView({ v }: { v: CodegraphCell }) {
  return v.c === 'dim' ? <span className="git-chip dim">{v.t}</span> : <span className={`git-cell ${v.c}`}>{v.t}</span>;
}

/**
 * Matrix, wide-only (`drawableCodegraphLayout`): a row per repo in rank order, the four checks then the size columns, the key last. A repo with no graph spans
 * one cell. The Reindex confirm opens as a row of its own under the repo's row, so the key column never has to hold it. No row expansion: the kinds strip
 * lives in the Inspector.
 */
export default function CodegraphMatrix(props: CodegraphLayoutProps) {
  const { ranked, nowMs } = props;
  return (
    <div className="git-panel git-mx-wrap">
      <table className="git-mx cg-mx">
        <thead>
          <tr>
            <th className="git-mx-dot" />
            <th>{MATRIX_COLUMNS.repo}</th>
            <th>{MATRIX_COLUMNS.index}</th>
            <th>{MATRIX_COLUMNS.changes}</th>
            <th>{MATRIX_COLUMNS.extractor}</th>
            <th>{MATRIX_COLUMNS.watcher}</th>
            <th className="cg-num">{MATRIX_COLUMNS.files}</th>
            <th className="cg-num">{MATRIX_COLUMNS.symbols}</th>
            <th className="cg-num">{MATRIX_COLUMNS.edges}</th>
            <th className="cg-num">{MATRIX_COLUMNS.db}</th>
            <th className="cg-num">{MATRIX_COLUMNS.indexed}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ranked.map(a => {
            const { repo } = a;
            if (a.level === 'none') {
              return (
                <tr key={repo.dirName} className="off">
                  <td className="git-mx-dot"><CodegraphDot level="none" /></td>
                  <td className="git-mx-rn"><div className="git-name">{repo.name}</div></td>
                  <td colSpan={COLUMNS - 3}><span className="git-cell na">{repo.state === 'missing' ? CODEGRAPH_FOLDER_GONE : MATRIX_NOT_INDEXED}</span></td>
                  <td className="git-mx-act" />
                </tr>
              );
            }
            const s = repo.state === 'ok' ? repo.stats : null;
            return (
              <Fragment key={repo.dirName}>
                <tr>
                  <td className="git-mx-dot"><CodegraphDot level={a.level} /></td>
                  <td className="git-mx-rn"><div className="git-name">{repo.name}</div></td>
                  {codegraphChecks(a).map((v, i) => <td key={i}><CellView v={v} /></td>)}
                  <td className="cg-num">{s ? fullCount(s.fileCount) : '—'}</td>
                  <td className="cg-num">{s ? compactCount(s.nodeCount) : '—'}</td>
                  <td className="cg-num">{s ? compactCount(s.edgeCount) : '—'}</td>
                  <td className="cg-num">{s ? formatDbSize(s.dbSizeBytes) : '—'}</td>
                  <td className="cg-num">{s ? indexedAge(s, nowMs) : '—'}</td>
                  <td className="git-mx-act"><CodegraphKeys a={a} ctx={props} /></td>
                </tr>
                {props.confirm.dirName === repo.dirName && (
                  <tr className="cg-mx-confirm">
                    <td colSpan={COLUMNS}><CodegraphConfirm a={a} ctx={props} /></td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
