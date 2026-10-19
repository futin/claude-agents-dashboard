import { useEffect, useRef } from 'react';

import type { CodegraphRunKind, CodegraphStats } from '../../../../shared/types';
import { codegraphRunKey, type CodegraphRunControl } from '../../hooks/useCodegraphRun';
import { CODEGRAPH_LEVEL_DOT, kindGroups, type CodegraphAssessed, type CodegraphLevel } from '../../lib/codegraphLevels';
import {
  CODEGRAPH_CHIP_INDEXING, CODEGRAPH_CHIP_NO_WATCHER, CODEGRAPH_CHIP_WATCHING, CODEGRAPH_CONFIRM_CANCEL, CODEGRAPH_CONFIRM_LABEL, CODEGRAPH_KEY_REINDEX,
  CODEGRAPH_KEY_REINDEXING, CODEGRAPH_KEY_SYNC, CODEGRAPH_KEY_SYNCING, CODEGRAPH_KIND_LABELS, CODEGRAPH_UP_TO_DATE, codegraphChip, codegraphKeyAria,
  fullCount, reindexConfirmText,
} from '../../lib/codegraphText';
import { useDismiss } from '../Popover';
import { GitSyncGlyph } from './GitParts';

/**
 * The pieces the three CodeGraph layouts (Inbox, Matrix, Inspector) share: the level dot, the chip row, the Sync / Reindex keys, the in-page Reindex confirm
 * and the symbols-by-kind strip. The shapes are Git's, so the classes are too (`.git-dot`, `.git-chip`, `.git-sync`); only what Git has no shape for is `cg-*`.
 */

/** What CodegraphView hands whichever layout is drawn, so none of them fetches or ranks for itself. */
export interface CodegraphLayoutProps {
  /** `rankCodegraphRepos` over the payload, computed once per payload; empty while `cli` is missing. */
  ranked: CodegraphAssessed[];
  nowMs: number;
  /** The server's home dir for `~/…` paths; '' until the pins payload answers. */
  home: string;
  runCtl: CodegraphRunControl;
  /** No write can succeed from this browser (read-only network, or a token the server wants and this browser lacks). */
  keysLocked: boolean;
  /** The one open Reindex confirm, by repo. */
  confirm: { dirName: string | null; ask(dirName: string): void; cancel(): void };
  openFolder(path: string): void;
  narrow: boolean;
}

export function CodegraphDot({ level }: { level: CodegraphLevel }) {
  return <span className={`git-dot ${CODEGRAPH_LEVEL_DOT[level]}`} aria-hidden="true" />;
}

/** A rebuild in flight, whoever started it: ours, a terminal's, or one the server outlived (`rebuildLive` with a synthesised `run`). */
export function isIndexing(a: CodegraphAssessed): boolean {
  return a.repo.run?.kind === 'reindex' || a.repo.rebuildLive;
}

/**
 * The repo's chips: one per problem (`codegraphChip`), the dashed "no watcher" a pending repo carries, the cyan "Indexing…" of a live rebuild and the plain
 * "watching". `upToDate` adds the Inspector's green chip on a quiet repo with stats.
 */
export function CodegraphChips({ a, upToDate = false }: { a: CodegraphAssessed; upToDate?: boolean }) {
  const { repo, problems } = a;
  const seen = new Set<string>();
  const chips = problems.map(p => codegraphChip(p, repo)).filter(c => !seen.has(c.text) && seen.add(c.text));
  return (
    <>
      {upToDate && a.level === 'quiet' && repo.state === 'ok' && <span className="git-chip green">{CODEGRAPH_UP_TO_DATE}</span>}
      {chips.map(c => <span key={c.text} className={`git-chip ${c.tone}`}>{c.text}</span>)}
      {problems.some(p => p.key === 'pending') && <span className="git-chip dim">{CODEGRAPH_CHIP_NO_WATCHER}</span>}
      {isIndexing(a) && <span className="git-chip cg-chip-run">{CODEGRAPH_CHIP_INDEXING}</span>}
      {repo.watching && <span className="git-chip">{CODEGRAPH_CHIP_WATCHING}</span>}
    </>
  );
}

/**
 * Which keys a repo's row offers, Sync before Reindex. A quiet repo gets Sync; a loud one gets Sync for pending changes or a failed sync, and Reindex for
 * any other problem (every other row of the copy table says "Reindex"). The kind of a run in flight always shows, so its cyan key is never missing.
 */
export function codegraphKeyKinds(a: CodegraphAssessed): CodegraphRunKind[] {
  if (a.level === 'none') return [];
  const keys = a.problems.map(p => p.key);
  let sync = a.level === 'quiet' || keys.includes('pending') || (keys.includes('lastRun') && a.repo.lastRun?.kind === 'sync');
  let reindex = keys.some(k => k !== 'pending');
  if (a.repo.run?.kind === 'sync') sync = true;
  if (a.repo.run?.kind === 'reindex') reindex = true;
  return [...(sync ? ['sync' as const] : []), ...(reindex ? ['reindex' as const] : [])];
}

/** Both keys are off while any POST of this tab is out, while the repo runs anything, or when no write can succeed; the cyan one stays cyan. */
function keyLocked(a: CodegraphAssessed, ctx: CodegraphLayoutProps): boolean {
  return ctx.runCtl.pendingKey !== null || a.repo.run !== null || ctx.keysLocked;
}

/**
 * One raised key (Git's `.git-sync`). Sync posts at once; Reindex opens the confirm, since it throws the DB away. Running — the repo's `run`, or this
 * tab's POST for that very key — it turns cyan with the glyph turning and reads "Syncing" / "Reindexing". Its click never bubbles to a clickable row.
 */
export function CodegraphKey({ a, kind, ctx, primary = false }: { a: CodegraphAssessed; kind: CodegraphRunKind; ctx: CodegraphLayoutProps; primary?: boolean }) {
  const { repo } = a;
  const live = repo.run?.kind === kind || ctx.runCtl.pendingKey === codegraphRunKey(repo.dirName, kind);
  const label = kind === 'sync' ? (live ? CODEGRAPH_KEY_SYNCING : CODEGRAPH_KEY_SYNC) : (live ? CODEGRAPH_KEY_REINDEXING : CODEGRAPH_KEY_REINDEX);
  return (
    <button
      type="button"
      className={`git-sync${live ? ' on cg-live' : primary ? ' primary' : ''}`}
      disabled={live || keyLocked(a, ctx)}
      aria-label={codegraphKeyAria(label, repo.name)}
      onClick={e => {
        e.stopPropagation();
        if (kind === 'sync') void ctx.runCtl.run(repo.dirName, repo.name, 'sync');
        else ctx.confirm.ask(repo.dirName);
      }}
    >
      <GitSyncGlyph />
      {label}
    </button>
  );
}

/** The row's keys per `codegraphKeyKinds`, or `kinds` when the layout fixes them (Inspector's footer). Reindex is primary on a repo that needs you. */
export function CodegraphKeys({ a, ctx, kinds }: { a: CodegraphAssessed; ctx: CodegraphLayoutProps; kinds?: CodegraphRunKind[] }) {
  return (
    <>
      {(kinds ?? codegraphKeyKinds(a)).map(k => <CodegraphKey key={k} a={a} kind={k} ctx={ctx} primary={k === 'reindex' && a.level === 'needs'} />)}
    </>
  );
}

/** The in-page Reindex confirm, drawn by the layout right under that repo's keys; nothing unless it is the repo asked about. */
export function CodegraphConfirm({ a, ctx, align = 'end' }: { a: CodegraphAssessed; ctx: CodegraphLayoutProps; align?: 'start' | 'end' }) {
  return ctx.confirm.dirName === a.repo.dirName ? <ConfirmBox a={a} ctx={ctx} align={align} /> : null;
}

function ConfirmBox({ a, ctx, align }: { a: CodegraphAssessed; ctx: CodegraphLayoutProps; align: 'start' | 'end' }) {
  const { repo } = a;
  const root = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDismiss(root, true, ctx.confirm.cancel);
  // Cancel takes focus, not Reindex: an Enter pressed by habit must not throw a graph away.
  useEffect(() => { cancelRef.current?.focus({ preventScroll: true }); }, []);
  return (
    <div ref={root} className={`cg-confirm${align === 'start' ? ' start' : ''}`} role="dialog" aria-label={CODEGRAPH_CONFIRM_LABEL} onClick={e => e.stopPropagation()}>
      <span className="cg-confirm-text">{reindexConfirmText(repo.name, repo.watching)}</span>
      <span className="cg-confirm-keys">
        <button
          type="button"
          className="git-key primary"
          disabled={keyLocked(a, ctx)}
          onClick={() => {
            ctx.confirm.cancel();
            void ctx.runCtl.run(repo.dirName, repo.name, 'reindex');
          }}
        >
          {CODEGRAPH_KEY_REINDEX}
        </button>
        <button type="button" className="git-key" ref={cancelRef} onClick={ctx.confirm.cancel}>{CODEGRAPH_CONFIRM_CANCEL}</button>
      </span>
    </div>
  );
}

/** The symbols-by-kind strip and its legend: six groups, always in `kindGroups`' order, so the legend never changes shape. */
export function CodegraphKinds({ stats }: { stats: CodegraphStats }) {
  const groups = kindGroups(stats.nodesByKind);
  return (
    <div className="cg-kinds-wrap">
      <div className="cg-kinds" aria-hidden="true">
        {groups.filter(g => g.count > 0).map(g => <span key={g.key} className={`cg-k-${g.key}`} style={{ flexGrow: g.count }} />)}
      </div>
      <div className="cg-legend">
        {groups.map(g => (
          <span key={g.key}><i className={`cg-k-${g.key}`} aria-hidden="true" />{CODEGRAPH_KIND_LABELS[g.key]} {fullCount(g.count)}</span>
        ))}
      </div>
    </div>
  );
}
