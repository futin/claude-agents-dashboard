/**
 * `POST /api/git-fetch` and the fetch clock on `GET /api/git-stats` through the real route table (git-fetch spec §2, D7, D8).
 *
 * The runner is reached only through `overrideFetchRunner`, wrapped in a spy over the real one so a refused request is proved by the spy seeing no `fetch`
 * rather than by the response alone. Pins come from `setPinned` over transcripts whose `cwd` is a clone of a local bare repo.
 */
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { GitFixture, withGitFixture } from './git-fixture.js';
import { makeFetchRunner, overrideFetchRunner, resetGitFetch } from '../server/lib/git-fetch.js';
import type { FetchRunner } from '../server/lib/git-fetch.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { resetSettings, setPinned, setSettings } from '../server/lib/settings.js';
import type { FetchClock, GitStatsResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nANSWER_TOKEN=secret\n';
const AUTH = { Authorization: 'Bearer secret' };

/** One transcript whose records carry `cwd`, the way `api-git-stats.test.ts` `plantProject` does. Returns the project's dirName. */
function plantProject(h: Harness, name: string, cwd: string): string {
  const dirName = encodeProjectDir(cwd);
  const dir = path.join(h.home, '.claude', 'projects', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-1.jsonl`), JSON.stringify(userRecord(`${name}-u1`, 'hi', cwd)) + '\n');
  return dirName;
}

/** A clone of a fresh bare origin with a root commit, so a fetch has a remote to ask and the stats read has a trunk. */
function cloneWithOrigin(fx: GitFixture, rel: string): string {
  const dir = fx.clone(fx.bare(`${rel}-origin.git`), rel);
  fx.commit(dir, `${rel} root`);
  return dir;
}

interface Spy { run: FetchRunner; fetches(): number }

function spy(): Spy {
  const inner = makeFetchRunner();
  let fetches = 0;
  const run: FetchRunner = (cwd, args, env) => {
    if (args.includes('fetch')) fetches++;
    return inner(cwd, args, env);
  };
  return { run, fetches: () => fetches };
}

/** Each case starts with no pins, a forgotten fetch clock and the real runner, and leaves them so. */
async function withGitFetchApi(fn: (h: Harness, fx: GitFixture) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withGitFixture(fx =>
      withServer(ENV, async h => {
        resetSettings();
        await resetGitFetch();
        overrideFetchRunner(null);
        try { await fn(h, fx); } finally { await resetGitFetch(); overrideFetchRunner(null); resetSettings(); }
      }));
  } finally {
    overrideClaudeRoots(null);
  }
}

const post = (h: Harness, headers: Record<string, string> = {}) => h.req('/api/git-fetch', { method: 'POST', headers });

async function stats(h: Harness): Promise<GitStatsResponse> {
  const reply = await h.req('/api/git-stats');
  assert.equal(reply.status, 200, reply.raw);
  return reply.json as unknown as GitStatsResponse;
}

export async function run(): Promise<number> {
  console.log('\n=== git fetch endpoint (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('POST without the token is 403 and nothing fetched; with it, 200 and a finished clock', async () => {
    await withGitFetchApi(async (h, fx) => {
      setPinned(plantProject(h, 'a', cloneWithOrigin(fx, 'repo-a')), true);
      const s = spy();
      overrideFetchRunner(s.run);

      const refused = await post(h);
      assert.equal(refused.status, 403, refused.raw);
      assert.deepStrictEqual(refused.json, { error: 'bad token' });
      assert.equal(s.fetches(), 0, 'a refused request must not reach git');

      const wrong = await post(h, { Authorization: 'Bearer nope' });
      assert.equal(wrong.status, 403);
      assert.equal(s.fetches(), 0);

      const reply = await post(h, AUTH);
      assert.equal(reply.status, 200, reply.raw);
      const clock = (reply.json as unknown as { fetch: FetchClock }).fetch;
      assert.equal(typeof clock.lastEndedMs, 'number');
      assert.strictEqual(clock.runningSinceMs, null);
      assert.equal(s.fetches(), 1);
    });
  }));

  check(await testAsync('a POST marks the Git view watched, so a set interval yields nextAtMs = lastEndedMs + interval', async () => {
    await withGitFetchApi(async h => {
      assert.ok(setSettings({ gitFetchSecs: 60 }));
      const reply = await post(h, AUTH);
      assert.equal(reply.status, 200, reply.raw);
      const clock = (reply.json as unknown as { fetch: FetchClock }).fetch;
      assert.equal(clock.intervalSecs, 60);
      assert.equal(typeof clock.lastEndedMs, 'number');
      assert.strictEqual(clock.nextAtMs, clock.lastEndedMs! + 60_000);
    });
  }));

  check(await testAsync('GET /api/git-fetch is 405 with Allow: POST', async () => {
    await withGitFetchApi(async h => {
      const reply = await h.req('/api/git-fetch');
      assert.equal(reply.status, 405, reply.raw);
      assert.equal(reply.headers['allow'], 'POST');
      assert.deepStrictEqual(reply.json, { error: 'method not allowed' });
    });
  }));

  check(await testAsync('GET /api/git-stats carries the four clock keys, and each ok repo its own lastFetch (null before any fetch)', async () => {
    await withGitFetchApi(async (h, fx) => {
      setPinned(plantProject(h, 'a', cloneWithOrigin(fx, 'repo-a')), true);
      const before = await stats(h);
      assert.ok(before.repos[0].state === 'ok' && before.repos[0].lastFetch === null);

      assert.equal((await post(h, AUTH)).status, 200);
      setPinned(plantProject(h, 'b', cloneWithOrigin(fx, 'repo-b')), true);
      const body = await stats(h);
      assert.deepStrictEqual(Object.keys(body.fetch).sort(), ['intervalSecs', 'lastEndedMs', 'nextAtMs', 'runningSinceMs']);
      const [a, b] = body.repos;
      assert.ok(a.state === 'ok' && b.state === 'ok');
      assert.ok(a.lastFetch, 'the fetched repo has a verdict');
      assert.deepStrictEqual(Object.keys(a.lastFetch).sort(), ['atMs', 'error']);
      assert.equal(typeof a.lastFetch.atMs, 'number');
      assert.strictEqual(a.lastFetch.error, null);
      assert.strictEqual(b.lastFetch, null, 'a repo pinned after the fetch has never been fetched');
    });
  }));

  check(await testAsync('the first GET /api/git-stats after a reset already answers a non-null nextAtMs when the interval is set', async () => {
    await withGitFetchApi(async h => {
      assert.ok(setSettings({ gitFetchSecs: 60 }));
      await resetGitFetch();
      const body = await stats(h);
      assert.equal(typeof body.fetch.nextAtMs, 'number', 'the first watched read enters the schedule (D11)');
    });
  }));

  console.log(`\ngit fetch endpoint: ${ok}/${total} passed`);
  return total - ok;
}
