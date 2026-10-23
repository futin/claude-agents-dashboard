/**
 * `server/lib/git-quick.ts`: fast-forward Pull and Push without a Claude session (spec `docs/superpowers/specs/2026-10-19-quick-pull-push-design.md`).
 * Every repo is real: a bare origin, the clone under test (`work`) and a second clone (`other`) that pushes the commits `work` is behind on. Git runs through
 * `overrideQuickRunner` with a spy over the real runner that records every call and adds a hermetic config overlay, so the user's own global git config
 * (a hooks path, an ssh command) cannot change a result.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { fetchAll, overrideFetchRunner, resetGitFetch } from '../server/lib/git-fetch.js';
import type { FetchRunner } from '../server/lib/git-fetch.js';
import { makeFetchRunner } from '../server/lib/git-fetch.js';
import { tryLockRepo } from '../server/lib/git-locks.js';
import { QUICK_TIMEOUT_MS, overrideQuickRunner, runQuickOp } from '../server/lib/git-quick.js';
import type { GitQuickPart, GitQuickResponse } from '../shared/types.js';
import { GitFixture, withGitFixture } from './git-fixture.js';

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn()
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

interface Call { cwd: string; args: string[]; env: Record<string, string> }
type Answer = Awaited<ReturnType<FetchRunner>>;

const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

/** Records every call; `canned` may answer one itself, `undefined` delegates to real git. */
function spy(canned?: (c: Call) => Promise<Answer> | undefined): { run: FetchRunner; calls: Call[] } {
  const inner = makeFetchRunner({ timeoutMs: QUICK_TIMEOUT_MS });
  const calls: Call[] = [];
  const run: FetchRunner = (cwd, args, env) => {
    const c = { cwd, args, env };
    calls.push(c);
    return canned?.(c) ?? inner(cwd, args, { ...env, ...HERMETIC });
  };
  return { run, calls };
}

interface Repo { fx: GitFixture; work: string; other: string; calls: Call[] }

/** A bare origin with `main`, cloned twice. Installs a plain spy unless the case installs its own. */
async function withRepo(fn: (r: Repo) => Promise<void>): Promise<void> {
  await withGitFixture(async fx => {
    await resetGitFetch();
    const o = fx.bare('o.git');
    const work = fx.clone(o, 'work');
    const other = fx.clone(o, 'other');
    const s = spy();
    overrideQuickRunner(s.run);
    try {
      await fn({ fx, work, other, calls: s.calls });
    } finally {
      overrideQuickRunner(null);
      overrideFetchRunner(null);
      await resetGitFetch();
    }
  });
}

/** `n` commits on `branch` in `dir`, pushed to origin. */
function pushCommits(fx: GitFixture, dir: string, branch: string, n: number, tag = branch): void {
  for (let i = 0; i < n; i++) fx.commit(dir, `${tag} ${i}`, { [`${tag.replace(/\W+/g, '-')}-${i}.txt`]: `${tag} ${i}` });
  fx.git(dir, ['push', '-q', 'origin', `${branch}:${branch}`]);
}

/** `branch` created in `other`, pushed, and checked out in `work` tracking `origin/<remoteName>`. */
function trackedBranch(fx: GitFixture, work: string, other: string, branch: string, remoteName = branch): void {
  fx.git(other, ['checkout', '-q', '-b', branch]);
  fx.git(other, ['push', '-q', 'origin', `${branch}:${remoteName}`]);
  fx.git(work, ['fetch', '-q', 'origin']);
  fx.git(work, ['checkout', '-q', '-b', branch, '--track', `origin/${remoteName}`]);
}

const pin = (dir: string) => ({ name: 'repo', toplevel: dir });
const sha = (fx: GitFixture, dir: string, ref: string): string => fx.git(dir, ['rev-parse', ref]);
const isRefspecFetch = (c: Call): boolean => c.args[0] === 'fetch' && c.args.length === 3;

function parts(r: GitQuickResponse): GitQuickPart[] {
  assert.strictEqual(r.refusal, null, `expected parts, got refusal ${r.refusal} (${r.detail})`);
  return r.parts;
}

export async function run(): Promise<number> {
  console.log('\n=== git-quick: fast-forward pull and push ===\n');
  let ok_ = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok_++; };

  check(await test('pull on the trunk, 1 behind an origin it has not fetched yet → fetches first, then one ff part of 1', async () => {
    await withRepo(async ({ fx, work, other }) => {
      pushCommits(fx, other, 'main', 1);
      const r = await runQuickOp(pin(work), 'pull');
      assert.deepStrictEqual(parts(r), [{ kind: 'ff', branch: 'main', target: 'origin/main', ok: true, commits: 1 }]);
      assert.strictEqual(r.repo, 'repo');
      assert.strictEqual(sha(fx, work, 'HEAD'), sha(fx, other, 'HEAD'));
    });
  }));

  check(await test('pull on feat/x 3 behind its upstream, trunk 5 behind and checked out nowhere → ff feat/x 3, then move main 5', async () => {
    await withRepo(async ({ fx, work, other }) => {
      trackedBranch(fx, work, other, 'feat/x');
      pushCommits(fx, other, 'feat/x', 3);
      fx.git(other, ['checkout', '-q', 'main']);
      pushCommits(fx, other, 'main', 5);
      const r = await runQuickOp(pin(work), 'pull');
      assert.deepStrictEqual(parts(r), [
        { kind: 'ff', branch: 'feat/x', target: 'origin/feat/x', ok: true, commits: 3 },
        { kind: 'move', branch: 'main', target: 'origin/main', ok: true, commits: 5 },
      ]);
      assert.strictEqual(fx.git(work, ['symbolic-ref', '--short', 'HEAD']), 'feat/x');
      assert.strictEqual(sha(fx, work, 'refs/heads/main'), sha(fx, other, 'main'));
      assert.strictEqual(sha(fx, work, 'refs/heads/feat/x'), sha(fx, other, 'feat/x'));
    });
  }));

  check(await test('pull with a local change the fast-forward would overwrite → failed ff part, HEAD and the change untouched', async () => {
    await withRepo(async ({ fx, work, other }) => {
      fx.commit(other, 'touch shared', { 'shared.txt': 'theirs' });
      fx.git(other, ['push', '-q', 'origin', 'main']);
      fs.writeFileSync(path.join(work, 'shared.txt'), 'mine');
      const before = sha(fx, work, 'HEAD');
      const [p] = parts(await runQuickOp(pin(work), 'pull'));
      assert.strictEqual(p.ok, false);
      assert.ok(!p.ok && p.detail.length > 0 && !/^(error|fatal): /.test(p.detail), JSON.stringify(p));
      assert.strictEqual(sha(fx, work, 'HEAD'), before);
      assert.strictEqual(fs.readFileSync(path.join(work, 'shared.txt'), 'utf8'), 'mine');
    });
  }));

  check(await test('pull with an unrelated local change → ff ok (decided with the user)', async () => {
    await withRepo(async ({ fx, work, other }) => {
      pushCommits(fx, other, 'main', 1);
      fs.writeFileSync(path.join(work, 'scratch.txt'), 'mine');
      assert.deepStrictEqual(parts(await runQuickOp(pin(work), 'pull')).map(p => p.ok), [true]);
    });
  }));

  check(await test('pull on a diverged trunk (ahead 1, behind 1) → nothing; local main unchanged', async () => {
    await withRepo(async ({ fx, work, other }) => {
      pushCommits(fx, other, 'main', 1);
      fx.commit(work, 'local only');
      const before = sha(fx, work, 'main');
      const r = await runQuickOp(pin(work), 'pull');
      assert.strictEqual(r.refusal, 'nothing');
      assert.strictEqual(sha(fx, work, 'main'), before);
    });
  }));

  check(await test('pull from a linked worktree on feat/y (no upstream) while main is checked out in the main checkout and 2 behind → nothing, no move', async () => {
    await withRepo(async ({ fx, work, other, calls }) => {
      pushCommits(fx, other, 'main', 2);
      const wt = fx.p('wt');
      fx.git(work, ['worktree', 'add', '-q', '-b', 'feat/y', wt]);
      const before = sha(fx, work, 'refs/heads/main');
      const r = await runQuickOp(pin(wt), 'pull');
      assert.strictEqual(r.refusal, 'nothing');
      assert.strictEqual(sha(fx, work, 'refs/heads/main'), before);
      assert.strictEqual(calls.filter(isRefspecFetch).length, 0);
    });
  }));

  check(await test('move refused by git → one failed move part carrying the stderr line without its fatal: prefix', async () => {
    await withRepo(async ({ fx, work, other }) => {
      pushCommits(fx, other, 'main', 2);
      fx.git(work, ['checkout', '-q', '-b', 'feat/z']);
      const s = spy(c => (isRefspecFetch(c)
        ? Promise.resolve({ code: 1, stdout: '', stderr: "fatal: refusing to fetch into branch 'refs/heads/main'\n", timedOut: false })
        : undefined));
      overrideQuickRunner(s.run);
      assert.deepStrictEqual(parts(await runQuickOp(pin(work), 'pull')), [
        { kind: 'move', branch: 'main', target: 'origin/main', ok: false, timedOut: false, detail: "refusing to fetch into branch 'refs/heads/main'" },
      ]);
    });
  }));

  check(await test('pull while a merge is in progress → in-progress, no fetch', async () => {
    await withRepo(async ({ fx, work, other, calls }) => {
      fx.commit(other, 'theirs', { 'c.txt': 'theirs' });
      fx.git(other, ['push', '-q', 'origin', 'main']);
      fx.commit(work, 'mine', { 'c.txt': 'mine' });
      fx.git(work, ['fetch', '-q', 'origin']);
      fx.git(work, ['merge', 'origin/main'], { allowFail: true });
      assert.ok(fs.existsSync(path.join(work, '.git', 'MERGE_HEAD')), 'the fixture should be mid-merge');
      calls.length = 0;
      assert.strictEqual((await runQuickOp(pin(work), 'pull')).refusal, 'in-progress');
      assert.strictEqual(calls.filter(c => c.args[0] === 'fetch').length, 0);
    });
  }));

  check(await test('a pin on a subfolder of a repo mid-merge → in-progress for pull and push, no fetch', async () => {
    await withRepo(async ({ fx, work, other, calls }) => {
      fx.commit(other, 'theirs', { 'c.txt': 'theirs' });
      fx.git(other, ['push', '-q', 'origin', 'main']);
      fx.commit(work, 'mine', { 'c.txt': 'mine' });
      fx.git(work, ['fetch', '-q', 'origin']);
      fx.git(work, ['merge', 'origin/main'], { allowFail: true });
      assert.ok(fs.existsSync(path.join(work, '.git', 'MERGE_HEAD')), 'the fixture should be mid-merge');
      const sub = path.join(work, 'sub');
      fs.mkdirSync(sub);
      calls.length = 0;
      assert.strictEqual((await runQuickOp(pin(sub), 'pull')).refusal, 'in-progress');
      assert.strictEqual((await runQuickOp(pin(sub), 'push')).refusal, 'in-progress');
      assert.strictEqual(calls.filter(c => c.args[0] === 'fetch' || c.args[0] === 'push').length, 0);
    });
  }));

  check(await test('pull on a detached HEAD → detached', async () => {
    await withRepo(async ({ fx, work }) => {
      fx.git(work, ['checkout', '-q', '--detach']);
      assert.strictEqual((await runQuickOp(pin(work), 'pull')).refusal, 'detached');
    });
  }));

  check(await test('a repo with no origin → no-origin', async () => {
    await withRepo(async ({ fx }) => {
      const lone = fx.init('lone');
      fx.commit(lone, 'root');
      assert.strictEqual((await runQuickOp(pin(lone), 'pull')).refusal, 'no-origin');
    });
  }));

  check(await test('push feat/x 2 ahead → one push part of 2 to origin/feat/x; origin matches local', async () => {
    await withRepo(async ({ fx, work, other }) => {
      trackedBranch(fx, work, other, 'feat/x');
      fx.commit(work, 'a');
      fx.commit(work, 'b');
      assert.deepStrictEqual(parts(await runQuickOp(pin(work), 'push')), [
        { kind: 'push', branch: 'feat/x', target: 'origin/feat/x', ok: true, commits: 2 },
      ]);
      assert.strictEqual(fx.git(fx.p('o.git'), ['rev-parse', 'refs/heads/feat/x']), sha(fx, work, 'HEAD'));
    });
  }));

  check(await test('push feat/x tracking origin/feature/x → target origin/feature/x; that branch moves, no feat/x appears on origin', async () => {
    await withRepo(async ({ fx, work, other }) => {
      trackedBranch(fx, work, other, 'feat/x', 'feature/x');
      fx.commit(work, 'a');
      assert.deepStrictEqual(parts(await runQuickOp(pin(work), 'push')), [
        { kind: 'push', branch: 'feat/x', target: 'origin/feature/x', ok: true, commits: 1 },
      ]);
      const o = fx.p('o.git');
      assert.strictEqual(fx.git(o, ['rev-parse', 'refs/heads/feature/x']), sha(fx, work, 'HEAD'));
      assert.strictEqual(fx.git(o, ['show-ref', '--verify', 'refs/heads/feat/x'], { allowFail: true }), '');
    });
  }));

  check(await test('push the remote rejects as non-fast-forward (origin moved since the last fetch) → failed part, origin unchanged', async () => {
    await withRepo(async ({ fx, work, other }) => {
      trackedBranch(fx, work, other, 'feat/x');
      pushCommits(fx, other, 'feat/x', 1, 'theirs');
      fx.commit(work, 'mine');
      const o = fx.p('o.git');
      const before = fx.git(o, ['rev-parse', 'refs/heads/feat/x']);
      const [p] = parts(await runQuickOp(pin(work), 'push'));
      assert.strictEqual(p.kind, 'push');
      assert.ok(!p.ok && p.detail.length > 0, JSON.stringify(p));
      assert.strictEqual(fx.git(o, ['rev-parse', 'refs/heads/feat/x']), before);
    });
  }));

  check(await test('push on a branch tracking another remote → nothing, and no push call', async () => {
    await withRepo(async ({ fx, work, calls }) => {
      fx.git(work, ['remote', 'add', 'upstream', fx.p('o.git')]);
      fx.git(work, ['fetch', '-q', 'upstream']);
      fx.git(work, ['checkout', '-q', '-b', 'feat/x', '--track', 'upstream/main']);
      fx.commit(work, 'a');
      assert.strictEqual((await runQuickOp(pin(work), 'push')).refusal, 'nothing');
      assert.strictEqual(calls.filter(c => c.args[0] === 'push').length, 0);
    });
  }));

  check(await test('push on a branch tracking origin/main → nothing', async () => {
    await withRepo(async ({ fx, work, calls }) => {
      fx.git(work, ['checkout', '-q', '-b', 'feat/x', '--track', 'origin/main']);
      fx.commit(work, 'a');
      assert.strictEqual((await runQuickOp(pin(work), 'push')).refusal, 'nothing');
      assert.strictEqual(calls.filter(c => c.args[0] === 'push').length, 0);
    });
  }));

  check(await test('push on the trunk 1 ahead → nothing (the trunk is never pushed)', async () => {
    await withRepo(async ({ fx, work, calls }) => {
      fx.commit(work, 'a');
      assert.strictEqual((await runQuickOp(pin(work), 'push')).refusal, 'nothing');
      assert.strictEqual(calls.filter(c => c.args[0] === 'push').length, 0);
    });
  }));

  check(await test('push runs the pre-push hook: a hook that exits 1 → failed part, origin unchanged', async () => {
    await withRepo(async ({ fx, work, other }) => {
      trackedBranch(fx, work, other, 'feat/x');
      fx.commit(work, 'a');
      const hook = path.join(work, '.git', 'hooks', 'pre-push');
      fs.writeFileSync(hook, '#!/bin/sh\necho "blocked by hook" >&2\nexit 1\n');
      fs.chmodSync(hook, 0o755);
      const o = fx.p('o.git');
      const before = fx.git(o, ['rev-parse', 'refs/heads/feat/x']);
      const [p] = parts(await runQuickOp(pin(work), 'push'));
      assert.ok(!p.ok, JSON.stringify(p));
      assert.strictEqual(fx.git(o, ['rev-parse', 'refs/heads/feat/x']), before);
    });
  }));

  check(await test('a second op on the same common dir while its lock is held → busy', async () => {
    await withRepo(async ({ fx, work, other }) => {
      pushCommits(fx, other, 'main', 1);
      const commonDir = fs.realpathSync(path.join(work, '.git'));
      const release = tryLockRepo(commonDir);
      assert.ok(release);
      try {
        assert.strictEqual((await runQuickOp(pin(work), 'pull')).refusal, 'busy');
      } finally {
        release();
      }
    });
  }));

  check(await test('an op while fetch-all is in flight → fetch-running', async () => {
    await withRepo(async ({ work }) => {
      // Fetch-all stays in flight while it waits on a lock elsewhere; its own git calls are canned so it touches nothing real once released.
      overrideFetchRunner(() => Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }));
      const release = tryLockRepo('/elsewhere')!;
      const p = fetchAll({});
      try {
        assert.strictEqual((await runQuickOp(pin(work), 'pull')).refusal, 'fetch-running');
      } finally {
        release();
        await p;
      }
    });
  }));

  check(await test('a git call that outlives the timeout → failed part with timedOut', async () => {
    await withRepo(async ({ fx, work, other }) => {
      pushCommits(fx, other, 'main', 1);
      overrideQuickRunner(spy(c => (c.args[0] === 'merge' ? Promise.resolve({ code: -1, stdout: '', stderr: '', timedOut: true }) : undefined)).run);
      const [p] = parts(await runQuickOp(pin(work), 'pull'));
      assert.deepStrictEqual(p, { kind: 'ff', branch: 'main', target: 'origin/main', ok: false, timedOut: true, detail: '' });
    });
  }));

  console.log(`\ngit-quick: ${ok_}/${total} passed`);
  return total - ok_;
}
