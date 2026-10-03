import type { RepoGitStats } from '../../../shared/types';
import { gitUpstreamShown } from './gitStatsText';

export type GitTriageGroup = 'needs' | 'flight' | 'quiet' | 'unreadable';

/**
 * Group repos for the Triage layout (spec §6). The first matching rule wins:
 *
 * 1. `unreadable`: any state but `ok`. Tested first because the other rules read fields only an `ok` repo has.
 * 2. `needs`: uncommitted work, the local trunk has diverged from `origin/<trunk>` in either direction, or the current branch is behind its upstream
 *    (as far as the upstream chip shows it: ahead-only, gone and an upstream of `origin/<trunk>` never raise a repo).
 * 3. `flight`: at least one unmerged branch. A repo with no remote or no trunk lands here too, since there every branch counts as unmerged.
 * 4. `quiet`: everything else.
 *
 * Each group keeps the input (pin) order, so a repo moves between groups but never reorders within one.
 */
export function triageGitRepos(repos: RepoGitStats[]): Record<GitTriageGroup, RepoGitStats[]> {
  const groups: Record<GitTriageGroup, RepoGitStats[]> = { needs: [], flight: [], quiet: [], unreadable: [] };
  for (const r of repos) groups[groupOf(r)].push(r);
  return groups;
}

function groupOf(r: RepoGitStats): GitTriageGroup {
  if (r.state !== 'ok') return 'unreadable';
  const diverged = r.trunkVsOrigin !== null && (r.trunkVsOrigin.ahead > 0 || r.trunkVsOrigin.behind > 0);
  const behindUpstream = (gitUpstreamShown(r)?.counts?.behind ?? 0) > 0;
  if (r.uncommitted > 0 || diverged || behindUpstream) return 'needs';
  if (r.unmergedTotal >= 1) return 'flight';
  return 'quiet';
}
