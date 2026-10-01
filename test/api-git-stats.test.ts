/**
 * `GET /api/git-stats` through the real route table (spec §3, §7): pin order, the memo dropping an unpinned repo's keys, failure staying per repo, a missing
 * git binary not taking the server down, and a concurrent request sharing one round of git calls.
 *
 * Pins come from `setPinned` (the token-guarded POST is `api-pins.test.ts`'s business) over transcripts whose `cwd` is a real fixture repo. The runner is
 * reached only through `overrideGitRunner`, the one seam the harness leaves, and every case restores it.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { GitFixture, withGitFixture } from './git-fixture.js';
import {
  GitTimeoutError, defaultGitRunner, gitStatsMemoKeys, makeGitRunner, overrideGitRunner,
} from '../server/lib/git-stats.js';
import type { GitRunner } from '../server/lib/git-stats.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';
import type { GitStatsResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/** One transcript whose records carry `cwd`, the way `api-pins.test.ts` `plantProject` does. Returns the project's dirName. */
function plantProject(h: Harness, name: string, cwd: string): string {
  const dirName = encodeProjectDir(cwd);
  const dir = path.join(h.home, '.claude', 'projects', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-1.jsonl`), JSON.stringify(userRecord(`${name}-u1`, 'hi', cwd)) + '\n');
  return dirName;
}

/** A repo on `main` with a root commit and one unmerged branch, so its read leaves ahead/behind keys in the memo. */
function repoWithBranch(fx: GitFixture, rel: string): string {
  const dir = fx.init(rel);
  fx.commit(dir, `${rel} root`);
  fx.git(dir, ['checkout', '-q', '-b', 'feature']);
  fx.commit(dir, `${rel} work`);
  fx.git(dir, ['checkout', '-q', 'main']);
  return dir;
}

/** Each case starts with no pins and the Claude-root filter off, and leaves both, and the runner, as it found them. */
async function withGitStats(fn: (h: Harness, fx: GitFixture) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withGitFixture(fx =>
      withServer(ENV, async h => {
        resetSettings();
        try { await fn(h, fx); } finally { overrideGitRunner(null); resetSettings(); }
      }));
  } finally {
    overrideClaudeRoots(null);
  }
}

async function get(h: Harness): Promise<GitStatsResponse> {
  const reply = await h.req('/api/git-stats');
  assert.equal(reply.status, 200, reply.raw);
  return reply.json as unknown as GitStatsResponse;
}

export async function run(): Promise<number> {
  console.log('\n=== git stats endpoint (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('no pins answers 200 with no repos', async () => {
    await withGitStats(async h => {
      const body = await get(h);
      assert.deepStrictEqual(body.repos, []);
      assert.equal(typeof body.generatedAt, 'number');
    });
  }));

  check(await testAsync('two pins answer in pin order, and reordering the pins reorders the answer', async () => {
    await withGitStats(async (h, fx) => {
      const a = plantProject(h, 'a', repoWithBranch(fx, 'repo-a'));
      const b = plantProject(h, 'b', repoWithBranch(fx, 'repo-b'));
      setPinned(a, true);
      setPinned(b, true);
      let body = await get(h);
      assert.deepStrictEqual(body.repos.map(r => r.dirName), [a, b]);
      assert.deepStrictEqual(body.repos.map(r => r.state), ['ok', 'ok']);

      setPinned(a, false);
      setPinned(a, true);
      body = await get(h);
      assert.deepStrictEqual(body.repos.map(r => r.dirName), [b, a]);
    });
  }));

  check(await testAsync('unpinning a repo drops it from the answer and its keys from the memo', async () => {
    await withGitStats(async (h, fx) => {
      const aDir = repoWithBranch(fx, 'repo-a');
      const bDir = repoWithBranch(fx, 'repo-b');
      const a = plantProject(h, 'a', aDir);
      const b = plantProject(h, 'b', bDir);
      setPinned(a, true);
      setPinned(b, true);
      await get(h);
      const has = (dir: string) => gitStatsMemoKeys().some(k => k.startsWith(dir));
      assert.ok(has(aDir) && has(bDir), 'both repos left memo entries behind');

      setPinned(b, false);
      const body = await get(h);
      assert.deepStrictEqual(body.repos.map(r => r.dirName), [a]);
      assert.ok(has(aDir), 'the pinned repo keeps its entries');
      assert.ok(!has(bDir), 'the unpinned repo left no key in the memo');
    });
  }));

  check(await testAsync('a runner that times out for one repo makes only that repo an error', async () => {
    await withGitStats(async (h, fx) => {
      const aDir = repoWithBranch(fx, 'repo-a');
      const a = plantProject(h, 'a', aDir);
      const b = plantProject(h, 'b', repoWithBranch(fx, 'repo-b'));
      setPinned(a, true);
      setPinned(b, true);
      overrideGitRunner((cwd, args) => cwd === aDir ? Promise.reject(new GitTimeoutError(5000)) : defaultGitRunner(cwd, args));

      const body = await get(h);
      const [ra, rb] = body.repos;
      assert.equal(ra.state, 'error');
      assert.equal(ra.state === 'error' && ra.message, 'git rev-parse timed out after 5s');
      assert.equal(rb.state, 'ok');
    });
  }));

  check(await testAsync('git missing for every call makes every repo "git not found" and leaves the server answering', async () => {
    await withGitStats(async (h, fx) => {
      const a = plantProject(h, 'a', repoWithBranch(fx, 'repo-a'));
      const b = plantProject(h, 'b', repoWithBranch(fx, 'repo-b'));
      setPinned(a, true);
      setPinned(b, true);
      overrideGitRunner(makeGitRunner({ bin: fx.p('no-such-git') }));

      const body = await get(h);
      assert.deepStrictEqual(body.repos.map(r => r.state), ['error', 'error']);
      assert.deepStrictEqual(body.repos.map(r => r.state === 'error' && r.message), ['git not found', 'git not found']);
      assert.equal((await h.req('/api/sessions')).status, 200, 'the server survived');
    });
  }));

  check(await testAsync('two concurrent requests share one round of git calls and one answer', async () => {
    await withGitStats(async (h, fx) => {
      const a = plantProject(h, 'a', repoWithBranch(fx, 'repo-a'));
      const b = plantProject(h, 'b', repoWithBranch(fx, 'repo-b'));
      setPinned(a, true);
      setPinned(b, true);
      // A pause on every call keeps the first read in flight for far longer than the second request needs to arrive.
      const calls: string[][] = [];
      const slow: GitRunner = async (cwd, args) => {
        calls.push(args);
        await new Promise(r => setTimeout(r, 40));
        return defaultGitRunner(cwd, args);
      };
      overrideGitRunner(slow);

      const [one, two] = await Promise.all([h.req('/api/git-stats'), h.req('/api/git-stats')]);
      assert.equal(one.status, 200);
      assert.equal(two.status, 200);
      assert.deepStrictEqual(one.json, two.json);
      assert.equal((one.json as unknown as GitStatsResponse).repos.length, 2);
      // The first call of every repo's read asks where its toplevel is: once per repo means one round, not two.
      assert.equal(calls.filter(c => c.includes('--show-toplevel')).length, 2);
    });
  }));

  console.log(`\ngit stats endpoint: ${ok}/${total} passed`);
  return total - ok;
}
