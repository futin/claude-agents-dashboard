/**
 * `GET /api/git-stats` — seven pins, one per state the Git layouts tell apart (rank order: lumen, aurora, harbor, tidepool, beacon, old-scripts, notes):
 * - aurora-api: look. On a feature branch with 2 unpushed commits and 2 stale branches; its 3 uncommitted files are calm under the working session.
 * - harbor-web: look. On trunk, 3 behind origin; the question session sits on feat/checkout-steps.
 * - lumen-cli: needs you. Off trunk on release/2.4, 5 behind its upstream, and the last fetch failed with an auth error.
 * - beacon: all good. Clean and level on trunk, with one ready branch to open a PR from.
 * - tidepool: all good, with two notes. Detached HEAD and no remote.
 * - old-scripts: can't read, the folder is gone. notes: can't read, not a git repo.
 */
import type { GitBranch, GitStatsResponse } from '../../../shared/types.js';

import { DAY, HOUR, MIN, ago } from './epoch.js';
import { HOME, PROJECTS } from './sessions.js';

const LUMEN = { name: 'lumen-cli', dirName: '-Users-dev-code-lumen-cli', path: `${HOME}/code/lumen-cli` };
const BEACON = { name: 'beacon', dirName: '-Users-dev-code-beacon', path: `${HOME}/code/beacon` };
const TIDEPOOL = { name: 'tidepool', dirName: '-Users-dev-code-tidepool', path: `${HOME}/code/tidepool` };
const OLD_SCRIPTS = { name: 'old-scripts', dirName: '-Users-dev-code-old-scripts', path: `${HOME}/code/old-scripts` };
const NOTES = { name: 'notes', dirName: '-Users-dev-notes', path: `${HOME}/notes` };

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
      originUrl: 'https://github.com/acme/aurora-api.git',
      trunkVsOrigin: { ahead: 0, behind: 0 },
      trunkRefs: { local: true, origin: true },
      currentVsUpstream: { upstream: 'origin/feat/orders-rate-limit', counts: { ahead: 2, behind: 0 } },
      fetchedAtMs: ago(4 * MIN),
      lastFetch: { atMs: ago(4 * MIN), error: null },
      branches: [
        ...branches(['feat/orders-rate-limit', 'fix/pagination-cursor', 'chore/bump-deps', 'feat/webhook-retries'], PROJECTS.aurora.path),
        { name: 'spike/cache-warmup', ahead: 2, behind: 24, lastCommitMs: ago(3 * DAY), worktreePath: null },
        { name: 'docs/api-guide', ahead: 1, behind: 2, lastCommitMs: ago(9 * DAY), worktreePath: null },
        { name: 'chore/lint-rules', ahead: 1, behind: 0, lastCommitMs: ago(5 * HOUR), worktreePath: null }
      ],
      unmergedTotal: 7,
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
      originUrl: 'https://gitlab.com/acme/web/harbor-web.git',
      trunkVsOrigin: { ahead: 0, behind: 3 },
      trunkRefs: { local: true, origin: true },
      currentVsUpstream: null,
      fetchedAtMs: ago(4 * MIN),
      lastFetch: { atMs: ago(4 * MIN), error: null },
      branches: branches(['feat/checkout-steps', 'fix/nav-overflow'], PROJECTS.harbor.path),
      unmergedTotal: 2,
      mergedCount: 6
    },
    {
      dirName: LUMEN.dirName,
      name: LUMEN.name,
      path: LUMEN.path,
      state: 'ok',
      toplevel: LUMEN.path,
      branch: 'release/2.4',
      detachedSha: null,
      onTrunk: false,
      uncommitted: 0,
      trunk: 'main',
      hasOrigin: true,
      originUrl: 'https://github.com/acme/lumen-cli.git',
      trunkVsOrigin: { ahead: 0, behind: 0 },
      trunkRefs: { local: true, origin: true },
      currentVsUpstream: { upstream: 'origin/release/2.4', counts: { ahead: 0, behind: 5 } },
      fetchedAtMs: ago(3 * HOUR),
      lastFetch: { atMs: ago(4 * MIN), error: 'auth' },
      branches: [
        { name: 'release/2.4', ahead: 6, behind: 0, lastCommitMs: ago(3 * HOUR), worktreePath: null },
        { name: 'feat/plugin-api', ahead: 11, behind: 18, lastCommitMs: ago(2 * DAY), worktreePath: null }
      ],
      unmergedTotal: 2,
      mergedCount: 42
    },
    {
      dirName: BEACON.dirName,
      name: BEACON.name,
      path: BEACON.path,
      state: 'ok',
      toplevel: BEACON.path,
      branch: 'main',
      detachedSha: null,
      onTrunk: true,
      uncommitted: 0,
      trunk: 'main',
      hasOrigin: true,
      originUrl: 'https://github.com/acme/beacon.git',
      trunkVsOrigin: { ahead: 0, behind: 0 },
      trunkRefs: { local: true, origin: true },
      currentVsUpstream: null,
      fetchedAtMs: ago(4 * MIN),
      lastFetch: { atMs: ago(4 * MIN), error: null },
      branches: [{ name: 'feat/dark-mode', ahead: 5, behind: 0, lastCommitMs: ago(1 * DAY), worktreePath: null }],
      unmergedTotal: 1,
      mergedCount: 0
    },
    {
      dirName: TIDEPOOL.dirName,
      name: TIDEPOOL.name,
      path: TIDEPOOL.path,
      state: 'ok',
      toplevel: TIDEPOOL.path,
      branch: null,
      detachedSha: 'a1b2c3d',
      onTrunk: false,
      uncommitted: 0,
      trunk: 'main',
      hasOrigin: false,
      originUrl: null,
      trunkVsOrigin: null,
      trunkRefs: { local: true, origin: false },
      currentVsUpstream: null,
      fetchedAtMs: null,
      lastFetch: null,
      branches: [],
      unmergedTotal: 0,
      mergedCount: 0
    },
    { dirName: OLD_SCRIPTS.dirName, name: OLD_SCRIPTS.name, path: OLD_SCRIPTS.path, state: 'missing' },
    { dirName: NOTES.dirName, name: NOTES.name, path: NOTES.path, state: 'not-git' }
  ],
  fetch: { intervalSecs: 300, nextAtMs: ago(4 * MIN) + 5 * MIN, runningSinceMs: null, lastEndedMs: ago(4 * MIN) },
  generatedAt: ago(0)
};

