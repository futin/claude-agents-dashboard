/** `GET /api/git-stats` — both pins are healthy repos: aurora-api on a feature branch ahead of its upstream, harbor-web on a trunk behind origin. */
import type { GitBranch, GitStatsResponse } from '../../../shared/types.js';

import { HOUR, MIN, ago } from './epoch.js';
import { PROJECTS } from './sessions.js';

function branches(names: string[], worktreeRoot: string): GitBranch[] {
  return names.map((name, i) => ({
    name,
    ahead: 1 + ((i * 3) % 7),
    behind: (i * 5) % 9,
    lastCommitMs: ago(i * 7 * HOUR + 20 * MIN),
    worktreePath: i === 1 ? `${worktreeRoot}/.worktrees/${name.split('/').pop()}` : null
  }));
}

export const gitStats: GitStatsResponse = {
  repos: [
    {
      dirName: PROJECTS.aurora.dirName,
      name: PROJECTS.aurora.name,
      path: PROJECTS.aurora.path,
      state: 'ok',
      toplevel: PROJECTS.aurora.path,
      branch: 'feat/orders-rate-limit',
      detachedSha: null,
      onTrunk: false,
      uncommitted: 3,
      trunk: 'main',
      hasOrigin: true,
      trunkVsOrigin: { ahead: 0, behind: 0 },
      trunkRefs: { local: true, origin: true },
      currentVsUpstream: { upstream: 'origin/feat/orders-rate-limit', counts: { ahead: 2, behind: 0 } },
      fetchedAtMs: ago(4 * MIN),
      lastFetch: { atMs: ago(4 * MIN), error: null },
      branches: branches(['feat/orders-rate-limit', 'fix/pagination-cursor', 'chore/bump-deps', 'feat/webhook-retries'], PROJECTS.aurora.path),
      unmergedTotal: 4,
      mergedCount: 11
    },
    {
      dirName: PROJECTS.harbor.dirName,
      name: PROJECTS.harbor.name,
      path: PROJECTS.harbor.path,
      state: 'ok',
      toplevel: PROJECTS.harbor.path,
      branch: 'main',
      detachedSha: null,
      onTrunk: true,
      uncommitted: 0,
      trunk: 'main',
      hasOrigin: true,
      trunkVsOrigin: { ahead: 0, behind: 3 },
      trunkRefs: { local: true, origin: true },
      currentVsUpstream: null,
      fetchedAtMs: ago(4 * MIN),
      lastFetch: { atMs: ago(4 * MIN), error: null },
      branches: branches(['feat/checkout-steps', 'fix/nav-overflow'], PROJECTS.harbor.path),
      unmergedTotal: 2,
      mergedCount: 6
    }
  ],
  fetch: { intervalSecs: 300, nextAtMs: ago(4 * MIN) + 5 * MIN, runningSinceMs: null, lastEndedMs: ago(4 * MIN) },
  generatedAt: ago(0)
};

