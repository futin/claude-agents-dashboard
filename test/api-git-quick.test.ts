/**
 * `POST /api/git-quick` through the real route table (quick pull/push spec §API). Git runs through `overrideQuickRunner`, wrapped in a spy over the real
 * runner, so a refused request is proved by the spy seeing no call rather than by the response alone.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { GitFixture, withGitFixture } from './git-fixture.js';
import { makeFetchRunner, resetGitFetch } from '../server/lib/git-fetch.js';
import type { FetchRunner } from '../server/lib/git-fetch.js';
import { tryLockRepo } from '../server/lib/git-locks.js';
import { QUICK_TIMEOUT_MS, overrideQuickRunner } from '../server/lib/git-quick.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';
import type { GitQuickResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nANSWER_TOKEN=secret\n';
const AUTH = { Authorization: 'Bearer secret' };
/** A LAN peer as Vite would deliver one: loopback writes need no token. */
const LAN = { 'X-Forwarded-For': '192.168.1.5' };
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

function plantProject(h: Harness, name: string, cwd: string): string {
  const dirName = encodeProjectDir(cwd);
  const dir = path.join(h.home, '.claude', 'projects', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-1.jsonl`), JSON.stringify(userRecord(`${name}-u1`, 'hi', cwd)) + '\n');
  return dirName;
}

/** Counts every call; `gate` may hold one back until the test lets it go. */
function spy(gate?: (args: string[]) => Promise<void> | undefined): { run: FetchRunner; calls: () => number } {
  const inner = makeFetchRunner({ timeoutMs: QUICK_TIMEOUT_MS });
  let calls = 0;
  const run: FetchRunner = async (cwd, args, env) => {
    calls++;
    await gate?.(args);
    return inner(cwd, args, { ...env, ...HERMETIC });
  };
  return { run, calls: () => calls };
}

/** `work` is a clone 1 commit behind its origin on main; `other` pushed that commit. */
function behindByOne(fx: GitFixture): { work: string; other: string } {
  const o = fx.bare('o.git');
  const work = fx.clone(o, 'work');
  const other = fx.clone(o, 'other');
  fx.commit(other, 'theirs');
  fx.git(other, ['push', '-q', 'origin', 'main']);
  return { work, other };
}

async function withQuickApi(fn: (h: Harness, fx: GitFixture) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withGitFixture(fx =>
      withServer(ENV, async h => {
        resetSettings();
        await resetGitFetch();
        try { await fn(h, fx); } finally { overrideQuickRunner(null); await resetGitFetch(); resetSettings(); }
      }));
  } finally {
    overrideClaudeRoots(null);
  }
}

const post = (h: Harness, body: unknown, headers: Record<string, string> = AUTH) =>
  h.req('/api/git-quick', { method: 'POST', headers: { ...LAN, ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export async function run(): Promise<number> {
  console.log('\n=== git quick endpoint (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('a LAN peer without the token is 403 and git is never called; with it, 200 and one ff part', async () => {
    await withQuickApi(async (h, fx) => {
      const { work } = behindByOne(fx);
      const dirName = plantProject(h, 'work', work);
      setPinned(dirName, true);
      const s = spy();
      overrideQuickRunner(s.run);

      const refused = await post(h, { dirName, op: 'pull' }, {});
      assert.equal(refused.status, 403, refused.raw);
      assert.equal(s.calls(), 0, 'a refused request must not reach git');

      const reply = await post(h, { dirName, op: 'pull' });
      assert.equal(reply.status, 200, reply.raw);
      const body = reply.json as unknown as GitQuickResponse;
      assert.strictEqual(body.refusal, null);
      assert.strictEqual(body.repo, 'work');
      assert.deepStrictEqual(body.parts, [{ kind: 'ff', branch: 'main', target: 'origin/main', ok: true, commits: 1 }]);
    });
  }));

  check(await testAsync('GET /api/git-quick is 405 with Allow: POST', async () => {
    await withQuickApi(async h => {
      const reply = await h.req('/api/git-quick');
      assert.equal(reply.status, 405, reply.raw);
      assert.equal(reply.headers['allow'], 'POST');
    });
  }));

  check(await testAsync('an unknown op or a non-string dirName is 400; a dirName that is not pinned is 404; git never called', async () => {
    await withQuickApi(async (h, fx) => {
      const { work } = behindByOne(fx);
      const dirName = plantProject(h, 'work', work);
      const s = spy();
      overrideQuickRunner(s.run);

      for (const body of [{ dirName, op: 'merge' }, { dirName: 7, op: 'pull' }, { dirName }]) {
        const reply = await post(h, body);
        assert.equal(reply.status, 400, `${JSON.stringify(body)} → ${reply.raw}`);
      }
      const unpinned = await post(h, { dirName, op: 'pull' });
      assert.equal(unpinned.status, 404, unpinned.raw);
      assert.deepStrictEqual(unpinned.json, { error: 'not a pinned project' });
      assert.equal(s.calls(), 0);
    });
  }));

  check(await testAsync('a repo whose lock is held answers 409 with refusal busy', async () => {
    await withQuickApi(async (h, fx) => {
      const { work } = behindByOne(fx);
      const dirName = plantProject(h, 'work', work);
      setPinned(dirName, true);
      const release = tryLockRepo(fs.realpathSync(path.join(work, '.git')))!;
      try {
        const reply = await post(h, { dirName, op: 'pull' });
        assert.equal(reply.status, 409, reply.raw);
        assert.strictEqual((reply.json as unknown as GitQuickResponse).refusal, 'busy');
      } finally {
        release();
      }
    });
  }));

  check(await testAsync('two pins on one repo (its root and a subfolder): while the first POST is held in its fetch, the second is 409 busy; released, the first is 200', async () => {
    await withQuickApi(async (h, fx) => {
      const { work } = behindByOne(fx);
      const sub = path.join(work, 'sub');
      fs.mkdirSync(sub);
      const a = plantProject(h, 'work', work);
      const b = plantProject(h, 'sub', sub);
      setPinned(a, true);
      setPinned(b, true);

      let reached!: () => void;
      const fetchReached = new Promise<void>(r => { reached = r; });
      let letGo!: () => void;
      const gate = new Promise<void>(r => { letGo = r; });
      let held = false;
      overrideQuickRunner(spy(args => {
        if (args[0] !== 'fetch' || held) return undefined;
        held = true;
        reached();
        return gate;
      }).run);

      const first = post(h, { dirName: a, op: 'pull' });
      // Racing the reply keeps a first POST that never reaches its fetch a failure, not a hang.
      const early = await Promise.race([fetchReached.then(() => null), first]);
      assert.strictEqual(early, null, `the first POST answered before its fetch: ${early?.status} ${early?.raw}`);
      const second = await post(h, { dirName: b, op: 'pull' });
      assert.equal(second.status, 409, second.raw);
      assert.strictEqual((second.json as unknown as GitQuickResponse).refusal, 'busy');
      letGo();
      const done = await first;
      assert.equal(done.status, 200, done.raw);
      assert.strictEqual((done.json as unknown as GitQuickResponse).refusal, null);
    });
  }));

  console.log(`\napi git-quick: ${ok}/${total} passed`);
  return total - ok;
}
