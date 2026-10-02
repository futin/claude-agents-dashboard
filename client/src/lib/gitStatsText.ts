import type { FetchClock, FetchError, GitBranch, RepoGitStats } from '../../../shared/types';
import { formatAgo } from './format';

/**
 * Every string of the Git sub-view's copy table (spec §6), kept out of the components so a wording change is one edit and the exact text is testable.
 * Pure: no React, no DOM, no clock beyond `formatAgo`'s own.
 */

type OkRepo = Extract<RepoGitStats, { state: 'ok' }>;

/** Branches shown before "+N more" (spec §6). */
export const GIT_BRANCHES_SHOWN = 5;
/** The server's per-repo cap on `branches`; `unmergedTotal` above it means some are not listed. */
export const GIT_BRANCH_CAP = 50;

export const GIT_NO_OPEN_BRANCHES = 'no open branches';
export const GIT_NO_PINS = 'No pinned projects yet. Pin one under Pinned.';
export const GIT_LOAD_FAILED = "Couldn't load git stats. Retrying every 30s.";
export const GIT_UPDATE_FAILED = "couldn't update";
export const GIT_BAND_SUB = 'Local state of your pinned repos. Fetches from origin on the timer set in Settings; nothing here pulls or pushes.';

// The sync/fetch clock chip and its popover (spec §4). `gitClock.ts` and the components import these and build none.
export const READ_SYNCING = 'syncing…';
export const READ_FETCHING = 'fetching…';
export const READ_FAILED = 'failed';
export const READ_OFF = 'off';
export const READ_OVERDUE = 'overdue';
export const READ_PENDING = '…';
export const METER_SYNC = 'SYNC';
export const METER_FETCH = 'FETCH';
export const METER_NEXT = 'next';
export const ROW_LOCAL_SYNC = 'Local sync';
export const ROW_FETCH_ALL = 'Fetch all';
export const KEY_NOW = 'now';
export const GIT_CLOCK_NAME = 'Sync and fetch clocks';
export const GIT_POP_LABEL = 'Sync and fetch';
export const SYNC_ROW_SUB = 're-reads the repos on disk · every 30s';
export const SYNC_ROW_FAILED_SUB = "couldn't update · retrying every 30s";
export const FETCH_ROW_BASE = 'git fetch origin';
export const FETCH_ROW_OFF_SUB = 'auto-fetch off · Settings › Shared';
export const FETCH_NEEDS_TOKEN = 'Fetch all needs the Answer token — set it under Settings › Local › Connection.';
export const FETCH_REFUSED = 'fetch refused: bad token — check it under Settings › Local › Connection.';
export const FETCH_START_FAILED = "couldn't start the fetch";
/** Before the first answer arrives — the same muted "Loading…" Management › Pinned shows while its scan runs. */
export const GIT_LOADING = 'Loading…';

/** The body's one line while there is no payload yet: still waiting, or the first fetch failed. */
export function gitFirstLoadText(error: boolean): string {
  return error ? GIT_LOAD_FAILED : GIT_LOADING;
}

/** The branch chip: the branch name, or the short sha while HEAD is detached. */
export function gitBranchChipText(r: OkRepo): string {
  return r.branch === null ? `detached at ${r.detachedSha}` : r.branch;
}

export function gitUncommittedText(n: number): string {
  return n > 0 ? `${n} uncommitted` : 'clean';
}

/**
 * Local trunk against origin's. `trunkVsOrigin: null` alone is ambiguous, so the null cases read `hasOrigin` and `trunkRefs`. A trunk-less repo says "no main
 * branch" even with an origin: there is no trunk to name.
 */
export function gitTrunkVsOriginText(r: OkRepo): string {
  if (r.trunk === null) return 'no main branch';
  if (!r.hasOrigin) return 'no remote';
  const d = r.trunkVsOrigin;
  if (d) {
    if (d.ahead === 0 && d.behind === 0) return `${r.trunk} = origin`;
    if (d.ahead === 0) return `${r.trunk} ${d.behind} behind origin`;
    if (d.behind === 0) return `${r.trunk} ${d.ahead} ahead of origin`;
    return `${r.trunk} ${d.ahead} ahead, ${d.behind} behind origin`;
  }
  return r.trunkRefs !== null && r.trunkRefs.origin ? `${r.trunk} only on origin` : `${r.trunk} not on origin`;
}

/** The age of the last fetch. `formatAgo` clamps a future mtime (clock skew) to "0s", so this never prints a negative age. */
export function gitFetchedAgeText(fetchedAtMs: number | null): string {
  return fetchedAtMs === null ? 'never fetched' : `fetched ${formatAgo(fetchedAtMs)} ago`;
}

/** The trouble word a failed fetch carries on a card and in the popover; `lock` is another fetch holding the repo's lock, which is not the repo's trouble. */
export function fetchTroubleWord(error: FetchError): string {
  switch (error) {
    case 'auth': return 'needs auth';
    case 'offline': return 'offline';
    case 'timeout': return 'fetch timed out';
    case 'other': return 'fetch failed';
    case 'lock': return '';
  }
}

/** The error a card shows, or null. Reads `lastFetch?.` because an older server's payload has no such property at all. */
function shownFetchError(r: OkRepo): Exclude<FetchError, 'lock'> | null {
  const e = r.lastFetch?.error;
  return e === undefined || e === null || e === 'lock' ? null : e;
}

/**
 * The card's fetched line. A running fetch outranks a past failure, but only for a repo with an origin: the fetch skips the others, so "fetching…" on them
 * would never resolve.
 */
export function gitFetchedText(repo: OkRepo, clock: FetchClock | undefined): { text: string; tone: 'live' | 'warn' | null } {
  if (clock?.runningSinceMs != null && repo.hasOrigin) return { text: READ_FETCHING, tone: 'live' };
  const error = shownFetchError(repo);
  if (error !== null) return { text: `${fetchTroubleWord(error)} · ${gitFetchedAgeText(repo.fetchedAtMs)}`, tone: 'warn' };
  return { text: gitFetchedAgeText(repo.fetchedAtMs), tone: null };
}

/**
 * The popover's trouble rows, as parts so the word alone can be coloured. `clock` is accepted so the rows follow the same signature as the card line, but a
 * running fetch does not hide them: the failure stands until a fetch succeeds.
 */
export function gitTroubleLines(repos: RepoGitStats[], _clock: FetchClock | undefined): { dirName: string; name: string; word: string; age: string }[] {
  const out: { dirName: string; name: string; word: string; age: string }[] = [];
  for (const r of repos) {
    if (r.state !== 'ok') continue;
    const error = shownFetchError(r);
    if (error !== null) out.push({ dirName: r.dirName, name: r.name, word: fetchTroubleWord(error), age: gitFetchedAgeText(r.fetchedAtMs) });
  }
  return out;
}

export function fetchPeriodText(intervalSecs: number): string {
  return intervalSecs < 60 ? `every ${intervalSecs}s` : `every ${intervalSecs / 60} min`;
}

/** The Fetch all row's sub-line: the command and its period, or the pointer to the setting while auto-fetch is off. `undefined` = no payload or an older server. */
export function fetchRowSub(intervalSecs: number | undefined): string {
  if (intervalSecs === undefined) return FETCH_ROW_BASE;
  return intervalSecs === 0 ? FETCH_ROW_OFF_SUB : `${FETCH_ROW_BASE} · ${fetchPeriodText(intervalSecs)}`;
}

/** "+N more" for a branch list of `branchCount`, which is `branches.length`, not `unmergedTotal`. */
export function gitMoreText(branchCount: number): string {
  return `+${branchCount - GIT_BRANCHES_SHOWN} more`;
}

/** The muted line under an expanded list when the server capped it: `unmergedTotal` is what exists, the cap is what it sent. */
export function gitNotShownText(unmergedTotal: number): string {
  return `${unmergedTotal - GIT_BRANCH_CAP} more not shown (over ${GIT_BRANCH_CAP})`;
}

export function gitMergedText(mergedCount: number): string {
  return `${mergedCount} merged branches hidden`;
}

/** The one sentence that replaces a non-`ok` repo's body, so broken numbers are never drawn. */
export function gitStateSentence(r: Exclude<RepoGitStats, { state: 'ok' }>): string {
  switch (r.state) {
    case 'missing': return r.path === null ? 'Folder is gone. Unpin it under Pinned.' : `Folder is gone — ${r.path}. Unpin it under Pinned.`;
    case 'not-git': return 'Not a git repository.';
    case 'error': return `Couldn't read: ${r.message}`;
  }
}

/**
 * A branch's divergence numbers, or null when it has none to show. Keys on `ahead`/`behind` rather than on the repo's `trunk`: a trunk can be named while no
 * base ref exists to compare against (a dangling origin/HEAD), and the branch then carries nulls.
 */
export function gitBranchCounts(b: GitBranch): { ahead: number; behind: number } | null {
  return b.ahead === null || b.behind === null ? null : { ahead: b.ahead, behind: b.behind };
}

/** The newest few branches, or all of them once the list is expanded. */
export function gitVisibleBranches(branches: GitBranch[], expanded: boolean): GitBranch[] {
  return expanded ? branches : branches.slice(0, GIT_BRANCHES_SHOWN);
}
