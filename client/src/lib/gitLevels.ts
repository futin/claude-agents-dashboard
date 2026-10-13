import type { GitBranch, RepoGitStats, Session } from '../../../shared/types';
import { gitUpstreamShown } from '../../../shared/gitUpstream';
import { formatAgo } from './format';
import { fetchTroubleWord, gitShownFetchError, gitStateSentence, gitTrunkVsOriginText } from './gitStatsText';

/**
 * The Git view's one rule, replacing the Triage grouping: every repo is read into problems, each with a severity, and the worst severity is its level
 * (spec §5). Pure: no React, no DOM, and the caller passes `nowMs`; only `formatAgo` reads `Date.now()`. Every layout draws from these exports so none can
 * disagree about a repo.
 */

type OkRepo = Extract<RepoGitStats, { state: 'ok' }>;

export type GitLevel = 'needs' | 'look' | 'quiet' | 'dead';
export type GitProblemKey = 'gone' | 'notgit' | 'error' | 'fetch' | 'dirty' | 'upstream' | 'pull' | 'push' | 'trunk' | 'remote' | 'detached' | 'stale';

/** `sev` 3 needs you, 2 is worth a look, 1 is a note. `calm` marks a problem an agent is already handling, which Sync must not offer to fix. */
export interface GitProblem {
  sev: 1 | 2 | 3;
  k: GitProblemKey;
  short: string;
  text: string;
  calm?: true;
}

export type GitAgentKind = 'working' | 'waiting' | 'idle';
export interface GitAgent {
  kind: GitAgentKind;
  label: string;
  sessionId: string;
}

export interface GitAssessed {
  repo: RepoGitStats;
  problems: GitProblem[];
  level: GitLevel;
  weight: number;
  verbs: string[];
}

/** A branch this far behind the base, or untouched this long, is a candidate for deleting. */
export const STALE_BEHIND = 20;
export const STALE_IDLE_MS = 604_800_000;

export const GIT_LEVELS: { key: GitLevel; label: string }[] = [
  { key: 'needs', label: 'Needs you' },
  { key: 'look', label: 'Worth a look' },
  { key: 'quiet', label: 'All good' },
  { key: 'dead', label: "Can't read" },
];
export const GIT_LEVEL_STATUS: Record<GitLevel, string> = { needs: 'needs you', look: 'worth a look', quiet: 'all good', dead: "can't read" };
/** The modifier on `.git-dot`; the `look` level keeps the shipped `flight` colour. */
export const GIT_LEVEL_DOT: Record<GitLevel, string> = { needs: 'needs', look: 'flight', quiet: 'quiet', dead: 'dead' };
export const GIT_LEVEL_RANK: Record<GitLevel, number> = { needs: 0, look: 1, quiet: 2, dead: 3 };

/** "<n> <word>", with the plural of a word ending in ch, sh, s or x taking `es`. */
export function gitPlural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word}${/(ch|sh|s|x)$/.test(word) ? 'es' : 's'}`;
}

export function isStaleBranch(b: GitBranch, nowMs: number): boolean {
  return (b.behind ?? 0) >= STALE_BEHIND || nowMs - b.lastCommitMs >= STALE_IDLE_MS;
}

/** Path containment by segment, so `/p/ab` is not under `/p/a`. */
function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root + '/');
}

const AGENT_ORDER: Partial<Record<Session['status'], number>> = { working: 0, question: 1, idle: 2 };

/**
 * The session sitting on `branch` of this repo, or null (spec §5.2). The join is by path, not by name: a session counts when its launch directory lies under
 * the repo's toplevel, its pin path, or the worktree the branch is checked out in, and its own `gitBranch` is that branch. A working agent beats a waiting one
 * beats an idle one, then the most recently active.
 */
export function agentOn(repo: RepoGitStats, branch: string | null, sessions: readonly Session[]): GitAgent | null {
  if (repo.state !== 'ok' || branch === null) return null;
  const worktree = repo.branches.find(b => b.name === branch)?.worktreePath ?? null;
  let best: Session | null = null;
  for (const s of sessions) {
    if (s.gitBranch !== branch || s.projectPath === null || AGENT_ORDER[s.status] === undefined) continue;
    const at = s.projectPath;
    if (!(within(at, repo.toplevel) || (repo.path !== null && within(at, repo.path)) || (worktree !== null && within(at, worktree)))) continue;
    if (best === null) { best = s; continue; }
    const rank = AGENT_ORDER[s.status]! - AGENT_ORDER[best.status]!;
    if (rank < 0 || (rank === 0 && s.updatedMs > best.updatedMs)) best = s;
  }
  if (best === null) return null;
  switch (best.status) {
    case 'working': return { kind: 'working', label: 'working', sessionId: best.id };
    case 'question': return { kind: 'waiting', label: 'needs answer', sessionId: best.id };
    default: return { kind: 'idle', label: `idle ${formatAgo(best.updatedMs)}`, sessionId: best.id };
  }
}

/** The spec §5.1 table: a repo's problems, worst first, ties in build order. A non-`ok` repo has one, and it fixes its level to `dead`. */
export function gitProblems(repo: RepoGitStats, sessions: readonly Session[], nowMs: number): GitProblem[] {
  switch (repo.state) {
    case 'missing': return [{ sev: 2, k: 'gone', short: 'folder gone', text: gitStateSentence(repo) }];
    case 'not-git': return [{ sev: 1, k: 'notgit', short: 'not a repository', text: gitStateSentence(repo) }];
    case 'error': return [{ sev: 1, k: 'error', short: "couldn't read", text: gitStateSentence(repo) }];
  }
  const r: OkRepo = repo;
  const out: GitProblem[] = [];

  const fetchError = gitShownFetchError(r);
  if (fetchError !== null) {
    const word = fetchTroubleWord(fetchError);
    const what = word.replace(/^fetch /, '');
    out.push({
      sev: 3, k: 'fetch', short: word,
      text: r.fetchedAtMs === null ? `Fetch ${what}, and origin has never been fetched` : `Fetch ${what}, so the origin numbers are ${formatAgo(r.fetchedAtMs)} old`,
    });
  }

  if (r.uncommitted > 0) {
    const n = r.uncommitted;
    const short = `${n} uncommitted`;
    const changes = gitPlural(n, 'uncommitted change');
    out.push(agentOn(r, r.branch, sessions)?.kind === 'working'
      ? { sev: 1, k: 'dirty', calm: true, short, text: `${changes}, and an agent is working on this branch` }
      : { sev: 3, k: 'dirty', short, text: `${changes} on ${r.branch ?? 'the detached HEAD'}` });
  }

  const u = gitUpstreamShown(r);
  if (u !== null) {
    if (u.counts === null) out.push({ sev: 1, k: 'upstream', short: `${u.upstream} gone`, text: `${u.upstream} is gone, so ${r.branch} tracks nothing` });
    else {
      if (u.counts.behind > 0) out.push({ sev: 3, k: 'pull', short: `${u.counts.behind} to pull`, text: `${r.branch} is ${u.counts.behind} behind ${u.upstream}` });
      if (u.counts.ahead > 0) {
        out.push({ sev: 2, k: 'push', short: `${u.counts.ahead} unpushed`, text: `${gitPlural(u.counts.ahead, 'commit')} on ${r.branch} not pushed yet` });
      }
    }
  }

  const d = r.trunkVsOrigin;
  if (d && (d.ahead > 0 || d.behind > 0)) {
    const gap = d.ahead === 0 ? `${d.behind} behind` : d.behind === 0 ? `${d.ahead} ahead` : `${d.ahead} ahead, ${d.behind} behind`;
    out.push({ sev: 2, k: 'trunk', short: `${r.trunk} ${gap}`, text: `Local ${gitTrunkVsOriginText(r)}` });
  }

  if (!r.hasOrigin) out.push({ sev: 1, k: 'remote', short: 'no remote', text: 'No remote, so nothing here is backed up' });
  if (r.branch === null) out.push({ sev: 1, k: 'detached', short: `detached at ${r.detachedSha}`, text: `HEAD detached at ${r.detachedSha}` });

  const stale = r.branches.filter(b => isStaleBranch(b, nowMs)).length;
  if (stale > 0) out.push({ sev: 1, k: 'stale', short: gitPlural(stale, 'stale branch'), text: `${gitPlural(stale, 'stale branch')} (≥ ${STALE_BEHIND} behind or idle a week)` });

  // Array.prototype.sort is stable, so equal severities keep the build order above.
  return out.sort((a, b) => b.sev - a.sev);
}

/** The worst severity decides: 3 needs you, 2 is worth a look, a note or nothing is quiet; anything unreadable is dead. */
export function gitLevelOf(repo: RepoGitStats, problems: readonly GitProblem[]): GitLevel {
  if (repo.state !== 'ok') return 'dead';
  const worst = problems.reduce((m, p) => Math.max(m, p.sev), 0);
  return worst >= 3 ? 'needs' : worst === 2 ? 'look' : 'quiet';
}

/** What Sync would do here, as verbs in a fixed order. A calm problem is an agent's own work, so it adds none. */
export function gitSyncVerbs(repo: RepoGitStats, problems: readonly GitProblem[]): string[] {
  if (repo.state !== 'ok') return [];
  const ks = new Set(problems.filter(p => !p.calm).map(p => p.k));
  const out: string[] = [];
  if (ks.has('dirty')) out.push('commit');
  if (ks.has('pull')) out.push('pull');
  if (ks.has('push')) out.push('push');
  if (ks.has('trunk')) out.push(`update ${repo.trunk}`);
  return out;
}

export function assessGitRepo(repo: RepoGitStats, sessions: readonly Session[], nowMs: number): GitAssessed {
  const problems = gitProblems(repo, sessions, nowMs);
  return {
    repo, problems, level: gitLevelOf(repo, problems),
    weight: problems.reduce((s, p) => s + p.sev, 0),
    verbs: gitSyncVerbs(repo, problems),
  };
}

/** Level first, then the heavier pile of problems; equal repos keep pin order (the sort is stable). */
export function rankGitRepos(repos: readonly RepoGitStats[], sessions: readonly Session[], nowMs: number): GitAssessed[] {
  return repos.map(r => assessGitRepo(r, sessions, nowMs)).sort((a, b) => GIT_LEVEL_RANK[a.level] - GIT_LEVEL_RANK[b.level] || b.weight - a.weight);
}

/** A problem's text as a full sentence, for a place that reads it aloud. */
export function gitSentence(text: string): string {
  return text.endsWith('.') ? text : text + '.';
}
