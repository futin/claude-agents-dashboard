/**
 * gitChecks.ts — the Git Inspector pane's check tiles (Working tree, Your branch, Trunk, Origin data; State for a repo git cannot read), apart from React so a
 * node test can drive them (`test/git/git-checks.test.ts`). `GitInspector` draws them.
 */
import type { FetchClock, FetchError } from '../../../shared/types';
import { formatAgo } from './format';
import type { GitAssessed } from './gitLevels';
import { fetchPeriodText, fetchTroubleWord, gitShownFetchError, gitStateSentence, gitTrunkVsOriginText } from './gitStatsText';
import type { OkRepo } from './gitSync';

/** A check tile's tone: its `.git-in-ck` modifier class. */
export type GitCheckTone = 'ok' | 'bad' | 'meh' | 'live';
/** One check tile: key, tone, value, and the optional hint under it. */
export interface GitCheck { k: string; c: GitCheckTone; v: string; h?: string }

const FETCH_HINT: Record<Exclude<FetchError, 'lock'>, string> = {
  auth: 'Run gh auth login in a terminal, then Retry fetch.',
  offline: 'Check the network, then Retry fetch.',
  timeout: 'Retry fetch; a slow remote can outlive the timeout.',
  other: 'Retry fetch, or run git fetch in a terminal to see why.',
};

export function workingTree(a: GitAssessed, repo: OkRepo, agentOnBranch: boolean): GitCheck {
  const k = 'Working tree';
  if (repo.uncommitted === 0) return { k, c: 'ok', v: 'Clean', h: 'Nothing to commit.' };
  const v = `${repo.uncommitted} uncommitted`;
  // The calm flag is the working-agent rule itself, so the tile and the level never disagree about it.
  if (a.problems.find(p => p.k === 'dirty')?.calm) return { k, c: 'meh', v, h: 'An agent is working here, so this is expected.' };
  return { k, c: 'bad', v, h: agentOnBranch ? 'An agent is on this branch but not working. Commit or stash.' : 'Nobody is on this branch. Commit or stash.' };
}

export function yourBranch(repo: OkRepo): GitCheck {
  const k = 'Your branch';
  if (repo.branch === null) return { k, c: 'meh', v: `Detached at ${repo.detachedSha}`, h: 'Check out a branch before committing.' };
  if (repo.onTrunk) return { k, c: 'ok', v: repo.branch, h: 'On trunk, tracked beside.' };
  const u = repo.currentVsUpstream ?? null;
  if (u === null) return { k, c: 'ok', v: repo.branch, h: 'No upstream set.' };
  if (repo.trunk !== null && u.upstream === `origin/${repo.trunk}`) return { k, c: 'ok', v: repo.branch, h: `Tracks ${u.upstream}.` };
  if (u.counts === null) return { k, c: 'meh', v: `${u.upstream} gone`, h: 'Its upstream is gone; push to set a new one.' };
  const { ahead, behind } = u.counts;
  const v = `↓${behind} ↑${ahead} vs ${u.upstream}`;
  if (behind > 0) return { k, c: 'bad', v, h: 'Pull before you push.' };
  if (ahead > 0) return { k, c: 'meh', v, h: 'Commits on this machine only.' };
  return { k, c: 'ok', v, h: 'In step.' };
}

export function trunk(repo: OkRepo): GitCheck {
  const k = 'Trunk';
  const d = repo.trunkVsOrigin;
  if (d === null) {
    return repo.hasOrigin ? { k, c: 'ok', v: gitTrunkVsOriginText(repo) } : { k, c: 'meh', v: 'No remote', h: 'Nothing here is backed up.' };
  }
  if (d.ahead > 0 || d.behind > 0) {
    return {
      k, c: 'meh', v: `${repo.trunk}${d.behind ? ` ↓${d.behind}` : ''}${d.ahead ? ` ↑${d.ahead}` : ''}`,
      h: d.behind > 0 ? `Local ${repo.trunk} is stale; new branches would start old.` : `Local ${repo.trunk} has commits origin lacks.`,
    };
  }
  return { k, c: 'ok', v: `${repo.trunk} = origin`, h: 'In step with origin.' };
}

export function originData(repo: OkRepo, clock: FetchClock | undefined): GitCheck {
  const k = 'Origin data';
  const e = gitShownFetchError(repo);
  if (e !== null) return { k, c: 'bad', v: `${repo.fetchedAtMs === null ? 'never' : formatAgo(repo.fetchedAtMs)} old · ${fetchTroubleWord(e)}`, h: FETCH_HINT[e] };
  if (clock?.runningSinceMs != null && repo.hasOrigin) return { k, c: 'live', v: 'fetching…' };
  if (repo.fetchedAtMs !== null) {
    return { k, c: 'ok', v: `${formatAgo(repo.fetchedAtMs)} old`, h: clock && clock.intervalSecs > 0 ? `Auto-fetch ${fetchPeriodText(clock.intervalSecs)}.` : 'Auto-fetch is off.' };
  }
  return { k, c: 'ok', v: 'Never fetched', h: repo.hasOrigin ? 'Not fetched yet.' : 'No remote to fetch.' };
}

export function stateCheck(repo: Exclude<GitAssessed['repo'], OkRepo>): GitCheck {
  const h = repo.state === 'missing'
    ? 'The folder moved or was deleted. Unpin it, or pin it again at its new path under Projects.'
    : repo.state === 'not-git' ? 'No .git above this folder. Pin the repo root instead.' : 'Git failed reading it; the next poll tries again.';
  return { k: 'State', c: 'meh', v: gitStateSentence(repo), h };
}
