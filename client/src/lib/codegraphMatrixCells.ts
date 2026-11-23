/**
 * codegraphMatrixCells.ts — the CodeGraph Matrix's four check columns (Index · Changes · Extractor · Watcher). Apart from React so a test can pin each cell.
 */
import type { CodegraphAssessed } from './codegraphLevels';
import { isIndexing } from './codegraphLevels';
import {
  CODEGRAPH_CHIP_INDEXING, MATRIX_CHANGES_NONE, MATRIX_INDEX_COMPLETE, MATRIX_WATCHER_OFF, MATRIX_WATCHER_ON, codegraphChip, codegraphPill, extractorCell,
  type CodegraphChipTone, type CodegraphPillColumn,
} from './codegraphText';

export type CodegraphCellTone = 'ok' | 'bad' | 'meh' | 'live' | 'na' | 'dim';
export interface CodegraphCell { c: CodegraphCellTone; t: string }

export const CODEGRAPH_NA_CELL: CodegraphCell = { c: 'na', t: '—' };
/** A problem's chip tone as Git's Matrix pill: amber is `bad`, mustard `meh`. */
const PILL_TONE: Record<CodegraphChipTone, CodegraphCellTone> = { amber: 'bad', mustard: 'meh' };

/** The first problem with a pill in `column` wins: problems come worst first, so that is the one the cell should say. */
export function codegraphPillCell(a: CodegraphAssessed, column: CodegraphPillColumn): CodegraphCell | null {
  for (const p of a.problems) {
    const pill = codegraphPill(p, a.repo);
    if (pill?.column === column) return { c: PILL_TONE[codegraphChip(p, a.repo).tone], t: pill.text };
  }
  return null;
}

/** The four check columns: grey text when fine, a pill only where a problem sits. Watcher is a pill only on a Worth a look repo, where it is the reason. */
export function codegraphChecks(a: CodegraphAssessed): CodegraphCell[] {
  const { repo } = a;
  const index = codegraphPillCell(a, 'index') ?? (isIndexing(a) ? { c: 'live' as const, t: CODEGRAPH_CHIP_INDEXING } : null);
  if (repo.state !== 'ok') return [index ?? CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL];
  const s = repo.stats;
  const pending = s.pending.added + s.pending.modified + s.pending.removed;
  const changes = codegraphPillCell(a, 'changes')
    ?? (pending > 0 ? { c: 'ok' as const, t: codegraphChip({ key: 'pending', sev: 2 }, repo).text } : { c: 'ok' as const, t: MATRIX_CHANGES_NONE });
  const extractor = codegraphPillCell(a, 'extractor') ?? { c: 'ok' as const, t: extractorCell(s) };
  const watcher: CodegraphCell = repo.watching ? { c: 'ok', t: MATRIX_WATCHER_ON } : { c: a.level === 'look' ? 'dim' : 'ok', t: MATRIX_WATCHER_OFF };
  return [index ?? { c: 'ok', t: MATRIX_INDEX_COMPLETE }, changes, extractor, watcher];
}
