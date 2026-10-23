import type { CodegraphRepo } from '../../../shared/types';

/**
 * The CodeGraph view's one rule, the design spec's Levels table: every repo is read into problems, each with a severity, and the worst severity is its level.
 * Pure: no React, no DOM, no clock. Every layout draws from these exports so none can disagree about a repo.
 *
 * It reads one repo at a time and knows nothing of the payload's `cli: 'missing'`: the server then marks every indexed row `error`, but the view draws the one
 * banner and no rows (spec §Client), so it must not rank or count repos in that case.
 */

export type CodegraphLevel = 'needs' | 'look' | 'quiet' | 'none';
export type CodegraphProblemKey = 'reindex' | 'partial' | 'failed' | 'unfinished' | 'error' | 'lastRun' | 'pending' | 'worktree';

/** `sev` 3 needs you, 2 is worth a look. There is no sev 1: a note-level finding has no row in the Levels table. */
export interface CodegraphProblem {
  key: CodegraphProblemKey;
  sev: 2 | 3;
}

export interface CodegraphAssessed {
  repo: CodegraphRepo;
  problems: CodegraphProblem[];
  level: CodegraphLevel;
  /** The repo's index in the payload, which is pin order. */
  order: number;
}

export const CODEGRAPH_LEVELS: { key: CodegraphLevel; label: string }[] = [
  { key: 'needs', label: 'Needs you' },
  { key: 'look', label: 'Worth a look' },
  { key: 'quiet', label: 'All good' },
  { key: 'none', label: 'Not indexed' },
];
/** The modifier on `.git-dot`: the shape is Git's, so the classes are too. */
export const CODEGRAPH_LEVEL_DOT: Record<CodegraphLevel, string> = { needs: 'needs', look: 'flight', quiet: 'quiet', none: 'dead' };
export const CODEGRAPH_LEVEL_RANK: Record<CodegraphLevel, number> = { needs: 0, look: 1, quiet: 2, none: 3 };

/**
 * A repo's problems in the Levels table's order, which is also worst first (every sev 3 row precedes every sev 2 row, so no sort is needed). `none` and `missing` have no graph, so nothing to be wrong with. A live rebuild
 * is a run, not a problem: `indexing` only counts when no rebuild is live (it then means a killed build). Pending changes with a watcher are quiet, since the
 * watcher picks them up within a second.
 */
export function codegraphProblems(repo: CodegraphRepo): CodegraphProblem[] {
  if (repo.state === 'none' || repo.state === 'missing') return [];
  const out: CodegraphProblem[] = [];
  if (repo.state === 'error') out.push({ key: 'error', sev: 3 });
  if (repo.state === 'ok') {
    const s = repo.stats;
    if (s.reindexRecommended) out.push({ key: 'reindex', sev: 3 });
    if (s.indexState === 'partial') out.push({ key: 'partial', sev: 3 });
    if (s.indexState === 'failed') out.push({ key: 'failed', sev: 3 });
    if (s.indexState === 'indexing' && !repo.rebuildLive) out.push({ key: 'unfinished', sev: 3 });
  }
  if (repo.lastRun !== null && !repo.lastRun.ok) out.push({ key: 'lastRun', sev: 3 });
  if (repo.state === 'ok') {
    const s = repo.stats;
    if (s.pending.added + s.pending.modified + s.pending.removed > 0 && !repo.watching) out.push({ key: 'pending', sev: 2 });
    if (s.worktreeMismatch !== null) out.push({ key: 'worktree', sev: 2 });
  }
  return out;
}

/** The worst severity decides: 3 needs you, 2 is worth a look, nothing is quiet; a repo with no graph is `none`. */
export function codegraphLevelOf(repo: CodegraphRepo, problems: readonly CodegraphProblem[]): CodegraphLevel {
  if (repo.state === 'none' || repo.state === 'missing') return 'none';
  const worst = problems.reduce((m, p) => Math.max(m, p.sev), 0);
  return worst >= 3 ? 'needs' : worst === 2 ? 'look' : 'quiet';
}

/** Level first, then the heavier pile of problems (summed severity); equal repos keep pin order (the sort is stable). */
export function rankCodegraphRepos(repos: readonly CodegraphRepo[]): CodegraphAssessed[] {
  const weight = (a: CodegraphAssessed) => a.problems.reduce((s, p) => s + p.sev, 0);
  return repos
    .map((repo, order): CodegraphAssessed => {
      const problems = codegraphProblems(repo);
      return { repo, problems, level: codegraphLevelOf(repo, problems), order };
    })
    .sort((a, b) => CODEGRAPH_LEVEL_RANK[a.level] - CODEGRAPH_LEVEL_RANK[b.level] || weight(b) - weight(a));
}

export type CodegraphKindKey = 'functions' | 'imports' | 'properties' | 'constants' | 'types' | 'other';

/** The CLI's node kinds that each named group counts; every kind not listed here is `other`, files included. */
const KIND_GROUPS: [Exclude<CodegraphKindKey, 'other'>, string[]][] = [
  ['functions', ['function']],
  ['imports', ['import']],
  ['properties', ['property']],
  ['constants', ['constant']],
  ['types', ['interface', 'type_alias']],
];

/** The symbols-by-kind strip: always the six groups in this order, so the legend never changes shape. `other` is whatever the named groups leave. */
export function kindGroups(nodesByKind: Record<string, number>): { key: CodegraphKindKey; count: number }[] {
  const named = new Set(KIND_GROUPS.flatMap(([, kinds]) => kinds));
  const groups = KIND_GROUPS.map(([key, kinds]) => ({ key, count: kinds.reduce((s, k) => s + (nodesByKind[k] ?? 0), 0) }));
  const other = Object.entries(nodesByKind).reduce((s, [k, n]) => (named.has(k) ? s : s + n), 0);
  return [...groups, { key: 'other', count: other }];
}
