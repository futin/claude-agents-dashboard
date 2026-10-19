import { Fragment } from 'react';

import type { CodegraphAssessed } from '../../lib/codegraphLevels';
import {
  CODEGRAPH_CHIP_INDEXING, CODEGRAPH_FOLDER_GONE, MATRIX_CHANGES_NONE, MATRIX_COLUMNS, MATRIX_INDEX_COMPLETE, MATRIX_NOT_INDEXED, MATRIX_WATCHER_OFF,
  MATRIX_WATCHER_ON, codegraphChip, codegraphPill, compactCount, extractorCell, formatDbSize, fullCount, indexedAge, type CodegraphChipTone,
  type CodegraphPillColumn,
} from '../../lib/codegraphText';
import { CodegraphConfirm, CodegraphDot, CodegraphKeys, isIndexing, type CodegraphLayoutProps } from './CodegraphParts';

type Tone = 'ok' | 'bad' | 'meh' | 'live' | 'na' | 'dim';
interface Cell { c: Tone; t: string }

const NA: Cell = { c: 'na', t: '—' };
/** A problem's chip tone as Git's Matrix pill: amber is `bad`, mustard `meh`. */
const PILL_TONE: Record<CodegraphChipTone, Tone> = { amber: 'bad', mustard: 'meh' };
const COLUMNS = 12;

/** The first problem with a pill in `column` wins: problems come worst first, so that is the one the cell should say. */
function pillFor(a: CodegraphAssessed, column: CodegraphPillColumn): Cell | null {
  for (const p of a.problems) {
    const pill = codegraphPill(p, a.repo);
    if (pill?.column === column) return { c: PILL_TONE[codegraphChip(p, a.repo).tone], t: pill.text };
  }
  return null;
}

/** The four check columns: grey text when fine, a pill only where a problem sits. Watcher is a pill only on a Worth a look repo, where it is the reason. */
function checks(a: CodegraphAssessed): Cell[] {
  const { repo } = a;
  const index = pillFor(a, 'index') ?? (isIndexing(a) ? { c: 'live' as const, t: CODEGRAPH_CHIP_INDEXING } : null);
  if (repo.state !== 'ok') return [index ?? NA, NA, NA, NA];
  const s = repo.stats;
  const pending = s.pending.added + s.pending.modified + s.pending.removed;
  const changes = pillFor(a, 'changes') ?? (pending > 0 ? { c: 'ok' as const, t: codegraphChip({ key: 'pending', sev: 2 }, repo).text } : { c: 'ok' as const, t: MATRIX_CHANGES_NONE });
  const extractor = pillFor(a, 'extractor') ?? { c: 'ok' as const, t: extractorCell(s) };
  const watcher: Cell = repo.watching ? { c: 'ok', t: MATRIX_WATCHER_ON } : { c: a.level === 'look' ? 'dim' : 'ok', t: MATRIX_WATCHER_OFF };
  return [index ?? { c: 'ok', t: MATRIX_INDEX_COMPLETE }, changes, extractor, watcher];
}

function CellView({ v }: { v: Cell }) {
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
                  {checks(a).map((v, i) => <td key={i}><CellView v={v} /></td>)}
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
