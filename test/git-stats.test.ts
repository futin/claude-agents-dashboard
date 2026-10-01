/**
 * `server/lib/git-stats.ts`: repo-level facts and the unmerged-branch list (spec `docs/superpowers/specs/2026-10-01-git-stats-design.md` §2, §7).
 * Every repo is real and built by `test/git-fixture.ts`; the reader runs through the real git runner wrapped in a spy that counts calls and in-flight
 * overlap.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  GIT_ENV,
  GitTimeoutError,
  defaultGitRunner,
  makeGitRunner,
  memoKeys,
  readRepo,
  trunkOf,
} from '../server/lib/git-stats.js';
import type { GitMemo, GitRunner } from '../server/lib/git-stats.js';
import type { PinRow, RepoGitStats } from '../shared/types.js';
import { GitFixture, withGitFixture } from './git-fixture.js';

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn()
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

interface Spy {
  run: GitRunner;
  calls: string[][];
  maxInFlight: number;
}

/** Wraps `inner` and records every call's args plus the highest number of calls ever in flight at once. */
function spy(inner: GitRunner = defaultGitRunner): Spy {
  const s: Spy = { calls: [], maxInFlight: 0, run: async () => ({ code: 0, stdout: '', stderr: '' }) };
  let inFlight = 0;
  s.run = async (cwd, args) => {
    s.calls.push(args);
    s.maxInFlight = Math.max(s.maxInFlight, ++inFlight);
    try { return await inner(cwd, args); } finally { inFlight--; }
  };
  return s;
}

function pin(p: string | null, name = 'repo'): PinRow {
  return { dirName: `-dir-${name}`, name, path: p, lastActiveMs: null, listed: true };
}

async function read(p: string | null, run: GitRunner = defaultGitRunner): Promise<RepoGitStats> {
  const memo: GitMemo = new Map();
  return readRepo(pin(p), run, memo);
}

/** Narrows to the `ok` variant, failing with the whole result otherwise. */
function ok(r: RepoGitStats): Extract<RepoGitStats, { state: 'ok' }> {
  assert.strictEqual(r.state, 'ok', `expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<RepoGitStats, { state: 'ok' }>;
}

/** The branch list and both counts, for the cases that assert all three at once. */
function tally(r: Extract<RepoGitStats, { state: 'ok' }>) {
  return { branches: r.branches, unmergedTotal: r.unmergedTotal, mergedCount: r.mergedCount };
}

/** A clone of a one-commit `main` origin. */
function cleanClone(fx: GitFixture): string {
  return fx.clone(fx.bare('origin.git'), 'work');
}

export async function run(): Promise<number> {
  console.log('\n=== git-stats: repo facts and branches ===\n');
  let ok_ = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok_++; };

  check(await test('clean clone on main: ok, on trunk, nothing uncommitted, level with origin, calls one at a time', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const s = spy();
      const r = ok(await read(work, s.run));
      assert.deepStrictEqual(
        { branch: r.branch, detachedSha: r.detachedSha, onTrunk: r.onTrunk, uncommitted: r.uncommitted, trunk: r.trunk, hasOrigin: r.hasOrigin },
        { branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0, trunk: 'main', hasOrigin: true },
      );
      assert.deepStrictEqual(r.trunkVsOrigin, { ahead: 0, behind: 0 });
      assert.deepStrictEqual(r.trunkRefs, { local: true, origin: true });
      assert.strictEqual(r.toplevel, work);
      assert.deepStrictEqual(
        { branches: r.branches, unmergedTotal: r.unmergedTotal, mergedCount: r.mergedCount },
        { branches: [], unmergedTotal: 0, mergedCount: 0 },
      );
      assert.deepStrictEqual({ dirName: r.dirName, name: r.name, path: r.path }, { dirName: '-dir-repo', name: 'repo', path: work });
      assert.strictEqual(s.maxInFlight, 1);
    });
  }));

  check(await test('one modified tracked file + one untracked file at the root → uncommitted 2', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const tracked = fs.readdirSync(work).find(f => f.endsWith('.txt'))!;
      fs.appendFileSync(path.join(work, tracked), 'more\n');
      fs.writeFileSync(path.join(work, 'new.txt'), 'x');
      assert.strictEqual(ok(await read(work)).uncommitted, 2);
    });
  }));

  check(await test('one staged rename + one untracked dir holding 2 files → uncommitted 2', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.commit(work, 'rename me', { 'old-name.txt': 'content that git can follow across a rename\n' });
      fx.git(work, ['mv', 'old-name.txt', 'new-name.txt']);
      fs.mkdirSync(path.join(work, 'loose'));
      fs.writeFileSync(path.join(work, 'loose', 'a.txt'), 'a');
      fs.writeFileSync(path.join(work, 'loose', 'b.txt'), 'b');
      assert.strictEqual(ok(await read(work)).uncommitted, 2);
    });
  }));

  check(await test('one .gitignored file and nothing else changed → uncommitted 0', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.commit(work, 'ignore logs', { '.gitignore': '*.log\n' });
      fs.writeFileSync(path.join(work, 'debug.log'), 'noise');
      assert.strictEqual(ok(await read(work)).uncommitted, 0);
    });
  }));

  check(await test('detached HEAD → branch null, detachedSha = git rev-parse --short HEAD', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '--detach']);
      // The machine's own config, as the reader sees it: a global core.abbrev must not make this differ.
      const expected = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
      const r = ok(await read(work));
      assert.strictEqual(r.branch, null);
      assert.strictEqual(r.detachedSha, expected);
      assert.strictEqual(r.onTrunk, false);
    });
  }));

  check(await test('unborn HEAD (fresh git init -b main) → ok, branch main, trunk null', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('fresh');
      const r = ok(await read(repo));
      assert.deepStrictEqual(
        {
          branch: r.branch, detachedSha: r.detachedSha, trunk: r.trunk, onTrunk: r.onTrunk,
          hasOrigin: r.hasOrigin, trunkVsOrigin: r.trunkVsOrigin, trunkRefs: r.trunkRefs, branches: r.branches,
        },
        { branch: 'main', detachedSha: null, trunk: null, onTrunk: false, hasOrigin: false, trunkVsOrigin: null, trunkRefs: null, branches: [] },
      );
    });
  }));

  check(await test('no remote, branch master → trunk master, hasOrigin false, trunkVsOrigin null', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('legacy', 'master');
      fx.commit(repo, 'first');
      const r = ok(await read(repo));
      assert.deepStrictEqual(
        { trunk: r.trunk, hasOrigin: r.hasOrigin, trunkVsOrigin: r.trunkVsOrigin, trunkRefs: r.trunkRefs, onTrunk: r.onTrunk },
        { trunk: 'master', hasOrigin: false, trunkVsOrigin: null, trunkRefs: { local: true, origin: false }, onTrunk: true },
      );
    });
  }));

  check(await test('origin exists but has no origin/main → trunkRefs {local: true, origin: false}, hasOrigin true', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('unpushed', 'main');
      fx.commit(repo, 'first');
      fx.git(repo, ['remote', 'add', 'origin', fx.bare('other-origin.git', ['elsewhere'])]);
      const r = ok(await read(repo));
      assert.deepStrictEqual(
        { trunk: r.trunk, hasOrigin: r.hasOrigin, trunkVsOrigin: r.trunkVsOrigin, trunkRefs: r.trunkRefs },
        { trunk: 'main', hasOrigin: true, trunkVsOrigin: null, trunkRefs: { local: true, origin: false } },
      );
    });
  }));

  check(await test('only branch dev, no origin → trunk null', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('devonly', 'dev');
      fx.commit(repo, 'first');
      const r = ok(await read(repo));
      assert.strictEqual(r.trunk, null);
      assert.strictEqual(r.trunkRefs, null);
      assert.strictEqual(await trunkOf(defaultGitRunner, repo), null);
    });
  }));

  check(await test('origin/HEAD → origin/develop with a local develop → trunk develop (origin/HEAD beats main)', async () => {
    await withGitFixture(async fx => {
      const work = fx.clone(fx.bare('origin.git', ['main', 'develop'], 'develop'), 'work');
      const r = ok(await read(work));
      assert.deepStrictEqual(
        { trunk: r.trunk, branch: r.branch, onTrunk: r.onTrunk, trunkVsOrigin: r.trunkVsOrigin },
        { trunk: 'develop', branch: 'develop', onTrunk: true, trunkVsOrigin: { ahead: 0, behind: 0 } },
      );
    });
  }));

  check(await test('origin/HEAD → origin/develop, no local develop → trunk develop, no trunkVsOrigin, off trunk, refs/heads/develop unnamed', async () => {
    await withGitFixture(async fx => {
      const work = fx.clone(fx.bare('origin.git', ['main', 'develop'], 'develop'), 'work');
      fx.git(work, ['checkout', '-q', '-b', 'feature']);
      fx.git(work, ['branch', '-q', '-D', 'develop']);
      const s = spy();
      const r = ok(await read(work, s.run));
      assert.deepStrictEqual(
        { trunk: r.trunk, trunkVsOrigin: r.trunkVsOrigin, trunkRefs: r.trunkRefs, onTrunk: r.onTrunk, branch: r.branch },
        { trunk: 'develop', trunkVsOrigin: null, trunkRefs: { local: false, origin: true }, onTrunk: false, branch: 'feature' },
      );
      const named = s.calls.filter(args => args.some(a => a.includes('refs/heads/develop')));
      assert.deepStrictEqual(named, []);
    });
  }));

  check(await test('local main 1 ahead, 2 behind origin/main → trunkVsOrigin {ahead: 1, behind: 2}', async () => {
    await withGitFixture(async fx => {
      const bare = fx.bare('origin.git');
      const work = fx.clone(bare, 'work');
      const other = fx.clone(bare, 'other');
      fx.commit(other, 'upstream one');
      fx.commit(other, 'upstream two');
      fx.git(other, ['push', '-q', 'origin', 'main']);
      fx.commit(work, 'local only');
      fx.git(work, ['fetch', '-q', 'origin']);
      assert.deepStrictEqual(ok(await read(work)).trunkVsOrigin, { ahead: 1, behind: 2 });
    });
  }));

  check(await test('mid-rebase with a conflict → ok, branch null, detachedSha set, uncommitted ≥ 1', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feature']);
      fx.commit(work, 'feature side', { 'clash.txt': 'feature\n' });
      fx.git(work, ['checkout', '-q', 'main']);
      fx.commit(work, 'main side', { 'clash.txt': 'main\n' });
      fx.git(work, ['checkout', '-q', 'feature']);
      fx.git(work, ['rebase', 'main'], { allowFail: true });
      const stopped = ['rebase-merge', 'rebase-apply'].some(d => fs.existsSync(path.join(work, '.git', d)));
      assert.ok(stopped, 'fixture: rebase should be stopped');
      const r = ok(await read(work));
      assert.strictEqual(r.branch, null);
      assert.ok(r.detachedSha && /^[0-9a-f]{4,}$/.test(r.detachedSha), `detachedSha ${r.detachedSha}`);
      assert.ok(r.uncommitted >= 1, `uncommitted ${r.uncommitted}`);
    });
  }));

  check(await test('mid-merge with a conflict on main → ok, branch main, detachedSha null, uncommitted ≥ 1', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'other']);
      fx.commit(work, 'other side', { 'clash.txt': 'other\n' });
      fx.git(work, ['checkout', '-q', 'main']);
      fx.commit(work, 'main side', { 'clash.txt': 'main\n' });
      fx.git(work, ['merge', 'other'], { allowFail: true });
      assert.ok(fs.existsSync(path.join(work, '.git', 'MERGE_HEAD')), 'fixture: merge should be stopped');
      const r = ok(await read(work));
      assert.strictEqual(r.branch, 'main');
      assert.strictEqual(r.detachedSha, null);
      assert.ok(r.uncommitted >= 1, `uncommitted ${r.uncommitted}`);
    });
  }));

  check(await test('pin with path null → missing, no git call', async () => {
    const s = spy();
    const r = await read(null, s.run);
    assert.strictEqual(r.state, 'missing');
    assert.strictEqual(s.calls.length, 0);
  }));

  check(await test('pin to a deleted folder → missing, no git call', async () => {
    await withGitFixture(async fx => {
      const gone = cleanClone(fx);
      fs.rmSync(gone, { recursive: true, force: true });
      const s = spy();
      const r = await read(gone, s.run);
      assert.strictEqual(r.state, 'missing');
      assert.strictEqual(s.calls.length, 0);
    });
  }));

  check(await test('pin to a plain folder → not-git', async () => {
    await withGitFixture(async fx => {
      const r = await read(fx.plain('notes'));
      assert.deepStrictEqual(r, { dirName: '-dir-repo', name: 'repo', path: fx.p('notes'), state: 'not-git' });
    });
  }));

  check(await test('pin to a repo subdirectory → toplevel is the repo root, same facts as pinning the root', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.commit(work, 'nested', { 'pkg/src/index.txt': 'x' });
      fs.writeFileSync(path.join(work, 'top-level-untracked.txt'), 'x');
      const sub = path.join(work, 'pkg', 'src');
      const fromSub = ok(await read(sub));
      const fromRoot = ok(await read(work));
      assert.strictEqual(fromSub.toplevel, work);
      assert.strictEqual(fromSub.path, sub);
      assert.deepStrictEqual({ ...fromSub, path: null }, { ...fromRoot, path: null });
      assert.strictEqual(fromSub.uncommitted, 1);
    });
  }));

  check(await test('no FETCH_HEAD anywhere → fetchedAtMs null', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      assert.ok(!fs.existsSync(path.join(work, '.git', 'FETCH_HEAD')), 'fixture: a clone should not write FETCH_HEAD');
      assert.strictEqual(ok(await read(work)).fetchedAtMs, null);
    });
  }));

  check(await test('.git/FETCH_HEAD mtime set 2h ago → fetchedAtMs is that mtime', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['fetch', '-q', 'origin']);
      const fetchHead = path.join(work, '.git', 'FETCH_HEAD');
      const at = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(fetchHead, at, at);
      assert.strictEqual(ok(await read(work)).fetchedAtMs, fs.statSync(fetchHead).mtimeMs);
    });
  }));

  check(await test('fetch run only from a linked worktree, 1h ago → fetchedAtMs is that worktree FETCH_HEAD mtime, .git/FETCH_HEAD absent', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const wt = fx.p('wt');
      fx.git(work, ['worktree', 'add', '-q', '-b', 'side', wt]);
      fx.git(wt, ['fetch', '-q', 'origin']);
      const wtFetchHead = path.join(work, '.git', 'worktrees', 'wt', 'FETCH_HEAD');
      assert.ok(fs.existsSync(wtFetchHead), 'fixture: the worktree fetch should write its own FETCH_HEAD');
      assert.ok(!fs.existsSync(path.join(work, '.git', 'FETCH_HEAD')), 'fixture: .git/FETCH_HEAD should be absent');
      const at = new Date(Date.now() - 3600_000);
      fs.utimesSync(wtFetchHead, at, at);
      assert.strictEqual(ok(await read(work)).fetchedAtMs, fs.statSync(wtFetchHead).mtimeMs);
    });
  }));

  check(await test('runner that rejects with a timeout → error whose message names the timeout', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const timingOut: GitRunner = async () => { throw new GitTimeoutError(5000); };
      const r = await read(work, timingOut);
      assert.strictEqual(r.state, 'error');
      assert.match((r as { message: string }).message, /timed out after 5s/);
    });
  }));

  check(await test('runner whose spawn fails with ENOENT → error "git not found"', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const noGit = makeGitRunner({ bin: fx.p('no-such-dir/git') });
      const r = await read(work, noGit);
      assert.deepStrictEqual(r, { dirName: '-dir-repo', name: 'repo', path: work, state: 'error', message: 'git not found' });
    });
  }));

  check(await test('the real runner rejects with GitTimeoutError when git outlives its timeout', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      // `hash-object --stdin` waits on a stdin the runner never closes, so it can only end by the timeout. It writes nothing without `-w`.
      await assert.rejects(
        makeGitRunner({ timeoutMs: 200 })(work, ['hash-object', '--stdin']),
        (e: unknown) => e instanceof GitTimeoutError && e.timeoutMs === 200,
      );
    });
  }));

  check(await test('GIT_ENV holds the three overrides, and the real runner hands them to the child', async () => {
    assert.strictEqual(GIT_ENV.GIT_OPTIONAL_LOCKS, '0');
    assert.strictEqual(GIT_ENV.GIT_TERMINAL_PROMPT, '0');
    assert.strictEqual(GIT_ENV.LC_ALL, 'C');
    await withGitFixture(async fx => {
      const res = await makeGitRunner({ bin: '/usr/bin/env' })(fx.root, []);
      const lines = res.stdout.split('\n');
      for (const kv of ['GIT_OPTIONAL_LOCKS=0', 'GIT_TERMINAL_PROMPT=0', 'LC_ALL=C']) assert.ok(lines.includes(kv), `child env lacks ${kv}`);
    });
  }));

  // ── Branches: unmerged list, ahead/behind against the base, merged proof, worktree badge, memo ──

  check(await test('branch 3 ahead / 2 behind origin/main → ahead 3, behind 2', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      for (const m of ['f1', 'f2', 'f3']) fx.commit(work, m);
      fx.git(work, ['checkout', '-q', 'main']);
      for (const m of ['m1', 'm2']) fx.commit(work, m);
      fx.git(work, ['push', '-q', 'origin', 'main']);
      const r = ok(await read(work));
      assert.deepStrictEqual(r.branches.map(b => ({ name: b.name, ahead: b.ahead, behind: b.behind })), [{ name: 'feat', ahead: 3, behind: 2 }]);
      assert.deepStrictEqual({ unmergedTotal: r.unmergedTotal, mergedCount: r.mergedCount }, { unmergedTotal: 1, mergedCount: 0 });
      assert.strictEqual(r.branches[0].lastCommitMs, Number(fx.git(work, ['log', '-1', '--format=%ct', 'feat'])) * 1000);
    });
  }));

  check(await test('branch fast-forward merged into main, pushed → hidden, mergedCount 1', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      fx.commit(work, 'done');
      fx.git(work, ['checkout', '-q', 'main']);
      fx.git(work, ['merge', '-q', '--ff-only', 'feat']);
      fx.git(work, ['push', '-q', 'origin', 'main']);
      const r = ok(await read(work));
      assert.deepStrictEqual(tally(r), { branches: [], unmergedTotal: 0, mergedCount: 1 });
    });
  }));

  check(await test('branch created at origin/main tip with no commits → hidden, mergedCount 1', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['branch', 'empty']);
      const r = ok(await read(work));
      assert.deepStrictEqual(tally(r), { branches: [], unmergedTotal: 0, mergedCount: 1 });
    });
  }));

  check(await test('single commit cherry-picked onto main, pushed → hidden by git cherry, mergedCount 1', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      fx.commit(work, 'pick me');
      fx.git(work, ['checkout', '-q', 'main']);
      fx.commit(work, 'main moves');
      fx.git(work, ['cherry-pick', 'feat']);
      fx.git(work, ['push', '-q', 'origin', 'main']);
      assert.strictEqual(fx.git(work, ['rev-list', '--count', 'origin/main..feat']), '1', 'fixture: feat should not be an ancestor of origin/main');
      const s = spy();
      const r = ok(await read(work, s.run));
      assert.deepStrictEqual(tally(r), { branches: [], unmergedTotal: 0, mergedCount: 1 });
      assert.ok(s.calls.some(a => a[0] === 'cherry'), 'the proof should have come from git cherry');
    });
  }));

  check(await test('2 commits squash-merged as 1 → shown as unmerged, ahead 2 (the accepted error)', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      fx.commit(work, 'part one');
      fx.commit(work, 'part two');
      fx.git(work, ['checkout', '-q', 'main']);
      fx.git(work, ['merge', '-q', '--squash', 'feat']);
      fx.git(work, ['commit', '-q', '-m', 'squash feat']);
      fx.git(work, ['push', '-q', 'origin', 'main']);
      const r = ok(await read(work));
      assert.deepStrictEqual(r.branches.map(b => ({ name: b.name, ahead: b.ahead })), [{ name: 'feat', ahead: 2 }]);
      assert.strictEqual(r.mergedCount, 0);
    });
  }));

  check(await test('X on the branch and cherry-picked onto main, plus a merge of main in the branch → shown (the no-merges rule refuses)', async () => {
    await withGitFixture(async fx => {
      // The merge lands before the cherry-pick. Merged after it, the merge would carry X' into the branch, leave no upstream-only commit for X to match,
      // and cherry would print `+`, so the no-merges rule would never be what refuses.
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      fx.commit(work, 'X');
      fx.git(work, ['checkout', '-q', 'main']);
      fx.commit(work, 'other');
      fx.git(work, ['checkout', '-q', 'feat']);
      fx.git(work, ['merge', '-q', '--no-edit', 'main']);
      fx.git(work, ['checkout', '-q', 'main']);
      fx.git(work, ['cherry-pick', fx.git(work, ['rev-parse', 'feat^1'])]);
      fx.git(work, ['push', '-q', 'origin', 'main']);
      const signs = fx.git(work, ['cherry', 'origin/main', 'feat']).split('\n').map(l => l[0]);
      assert.ok(signs.length >= 1 && signs.every(c => c === '-'), `fixture: cherry should print only '-', got ${JSON.stringify(signs)}`);
      const r = ok(await read(work));
      assert.deepStrictEqual(r.branches.map(b => ({ name: b.name, ahead: b.ahead })), [{ name: 'feat', ahead: 2 }]);
      assert.strictEqual(r.mergedCount, 0);
    });
  }));

  check(await test('local main behind origin/main, branch merged on origin only → hidden (base is origin/main)', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      fx.commit(work, 'landed upstream');
      fx.git(work, ['push', '-q', 'origin', 'feat:main']);
      fx.git(work, ['checkout', '-q', 'main']);
      assert.strictEqual(fx.git(work, ['rev-list', '--count', 'main..feat']), '1', 'fixture: local main should not contain feat');
      const r = ok(await read(work));
      assert.deepStrictEqual(tally(r), { branches: [], unmergedTotal: 0, mergedCount: 1 });
      assert.deepStrictEqual(r.trunkVsOrigin, { ahead: 0, behind: 1 });
    });
  }));

  check(await test('no trunk, branches a and b → both listed with ahead/behind null, mergedCount 0', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('notrunk', 'a');
      fx.commit(repo, 'on a');
      fx.git(repo, ['checkout', '-q', '-b', 'b']);
      fx.commit(repo, 'on b');
      const s = spy();
      const r = ok(await read(repo, s.run));
      assert.strictEqual(r.trunk, null);
      assert.deepStrictEqual(
        r.branches.map(b => ({ name: b.name, ahead: b.ahead, behind: b.behind })),
        [{ name: 'b', ahead: null, behind: null }, { name: 'a', ahead: null, behind: null }],
      );
      assert.deepStrictEqual({ unmergedTotal: r.unmergedTotal, mergedCount: r.mergedCount }, { unmergedTotal: 2, mergedCount: 0 });
      assert.ok(!s.calls.some(a => a[0] === 'rev-list' || a[0] === 'cherry'), 'nothing to compare against, so no rev-list or cherry');
    });
  }));

  check(await test('worktree badge: linked worktree branch → its realpath, main worktree branch → null, also from a pin on that worktree', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'mainside']);
      fx.commit(work, 'in main worktree');
      const wt = fx.p('wt');
      fx.git(work, ['worktree', 'add', '-q', '-b', 'side', wt]);
      fx.commit(wt, 'in linked worktree');
      const badges = (r: RepoGitStats) => Object.fromEntries(ok(r).branches.map(b => [b.name, b.worktreePath]));

      assert.deepStrictEqual(badges(await read(work)), { side: fs.realpathSync(wt), mainside: null });

      const fromWt = ok(await readRepo({ ...pin(wt), listed: false }, defaultGitRunner, new Map()));
      assert.strictEqual(fromWt.branch, 'side');
      assert.strictEqual(fromWt.toplevel, wt);
      assert.deepStrictEqual(badges(fromWt), { side: fs.realpathSync(wt), mainside: null });
    });
  }));

  check(await test('7 unmerged branches with distinct commit dates → all 7, newest first, unmergedTotal 7', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const order = [3, 7, 1, 5, 2, 6, 4];
      order.forEach((rank, i) => {
        const name = `b${i + 1}`;
        fx.git(work, ['checkout', '-q', '-b', name, 'main']);
        fx.commit(work, name, { [`${name}.txt`]: name }, 1_800_000_000 + rank * 1000);
      });
      fx.git(work, ['checkout', '-q', 'main']);
      const r = ok(await read(work));
      const expected = order.map((rank, i) => ({ name: `b${i + 1}`, rank })).sort((x, y) => y.rank - x.rank).map(x => x.name);
      assert.deepStrictEqual(r.branches.map(b => b.name), expected);
      assert.deepStrictEqual(r.branches.map(b => b.lastCommitMs), [...r.branches.map(b => b.lastCommitMs)].sort((x, y) => y - x));
      assert.strictEqual(r.unmergedTotal, 7);
    });
  }));

  check(await test('60 unmerged branches → 50 newest listed, unmergedTotal 60, never two git calls in flight', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      const names = Array.from({ length: 60 }, (_, i) => `b${String(i).padStart(2, '0')}`);
      for (const name of names) {
        fx.git(work, ['checkout', '-q', '-b', name, 'main']);
        fx.commit(work, name);
      }
      fx.git(work, ['checkout', '-q', 'main']);
      const s = spy();
      const r = ok(await read(work, s.run));
      assert.strictEqual(r.branches.length, 50);
      assert.strictEqual(r.unmergedTotal, 60);
      assert.deepStrictEqual(r.branches.map(b => b.name), names.slice(10).reverse());
      assert.strictEqual(s.maxInFlight, 1);
    });
  }));

  check(await test('branches feat/ü-x and fix/a.b → listed under those exact names with correct numbers', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat/ü-x']);
      fx.commit(work, 'u one');
      fx.commit(work, 'u two');
      fx.git(work, ['checkout', '-q', '-b', 'fix/a.b', 'main']);
      fx.commit(work, 'dot one');
      fx.git(work, ['checkout', '-q', 'main']);
      fx.commit(work, 'main moves');
      fx.git(work, ['push', '-q', 'origin', 'main']);
      const r = ok(await read(work));
      assert.deepStrictEqual(
        r.branches.map(b => ({ name: b.name, ahead: b.ahead, behind: b.behind })),
        [{ name: 'fix/a.b', ahead: 1, behind: 1 }, { name: 'feat/ü-x', ahead: 2, behind: 1 }],
      );
    });
  }));

  check(await test('second read with no sha moved → no rev-list of any form and no cherry, trunk row included; same result', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'feat']);
      fx.commit(work, 'unmerged work');
      fx.git(work, ['checkout', '-q', '-b', 'picked', 'main']);
      fx.commit(work, 'picked work');
      fx.git(work, ['checkout', '-q', 'main']);
      fx.commit(work, 'main moves');
      fx.git(work, ['cherry-pick', 'picked']);
      fx.git(work, ['push', '-q', 'origin', 'main']);
      fx.commit(work, 'local main only'); // local trunk 1 ahead of origin/main: the trunk row has something to count
      const memo: GitMemo = new Map();
      const first = spy();
      const r1 = ok(await readRepo(pin(work), first.run, memo));
      assert.ok(first.calls.some(a => a[0] === 'rev-list') && first.calls.some(a => a[0] === 'cherry'), 'fixture: the cold read should compute');
      assert.deepStrictEqual(r1.trunkVsOrigin, { ahead: 1, behind: 0 });
      assert.deepStrictEqual({ names: r1.branches.map(b => b.name), mergedCount: r1.mergedCount }, { names: ['feat'], mergedCount: 1 });
      const second = spy();
      const r2 = ok(await readRepo(pin(work), second.run, memo));
      assert.deepStrictEqual(second.calls.filter(a => a[0] === 'rev-list' || a[0] === 'cherry'), []);
      assert.deepStrictEqual(r2, r1);
    });
  }));

  check(await test('branch deleted between reads → memo holds no key with its sha afterwards', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.git(work, ['checkout', '-q', '-b', 'keep']);
      fx.commit(work, 'kept');
      fx.git(work, ['checkout', '-q', '-b', 'doomed', 'main']);
      fx.commit(work, 'doomed');
      fx.git(work, ['checkout', '-q', 'main']);
      const keepSha = fx.git(work, ['rev-parse', 'keep']);
      const doomedSha = fx.git(work, ['rev-parse', 'doomed']);
      const memo: GitMemo = new Map();
      await readRepo(pin(work), defaultGitRunner, memo);
      assert.ok(memoKeys(memo).some(k => k.includes(doomedSha)), 'fixture: the first read should memoise doomed');
      fx.git(work, ['branch', '-q', '-D', 'doomed']);
      await readRepo(pin(work), defaultGitRunner, memo);
      assert.deepStrictEqual(memoKeys(memo).filter(k => k.includes(doomedSha)), []);
      assert.ok(memoKeys(memo).some(k => k.includes(keepSha)), 'a branch that still exists keeps its entry');
    });
  }));

  check(await test('the trunk itself is never in branches nor counted merged (local main ahead of origin; no-remote master)', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      fx.commit(work, 'unpushed on main');
      const r = ok(await read(work));
      assert.deepStrictEqual(tally(r), { branches: [], unmergedTotal: 0, mergedCount: 0 });

      const legacy = fx.init('legacy', 'master');
      fx.commit(legacy, 'first');
      fx.git(legacy, ['checkout', '-q', '-b', 'feat']);
      fx.commit(legacy, 'feature');
      const l = ok(await read(legacy));
      assert.deepStrictEqual(l.branches.map(b => ({ name: b.name, ahead: b.ahead, behind: b.behind })), [{ name: 'feat', ahead: 1, behind: 0 }]);
      assert.deepStrictEqual({ unmergedTotal: l.unmergedTotal, mergedCount: l.mergedCount }, { unmergedTotal: 1, mergedCount: 0 });
    });
  }));

  check(await test('origin/HEAD → origin/develop, no local develop; branch 2 ahead → ahead 2, behind 0, refs/heads/develop never named', async () => {
    await withGitFixture(async fx => {
      const work = fx.clone(fx.bare('origin.git', ['main', 'develop'], 'develop'), 'work');
      fx.git(work, ['checkout', '-q', '-b', 'feature']);
      fx.git(work, ['branch', '-q', '-D', 'develop']);
      fx.commit(work, 'feature one');
      fx.commit(work, 'feature two');
      const s = spy();
      const r = ok(await read(work, s.run));
      assert.deepStrictEqual(r.branches.map(b => ({ name: b.name, ahead: b.ahead, behind: b.behind })), [{ name: 'feature', ahead: 2, behind: 0 }]);
      assert.deepStrictEqual(s.calls.filter(args => args.some(a => a.includes('refs/heads/develop'))), []);
    });
  }));

  check(await test('folder deleted between the stat and the first git call → missing, not "git not found"', async () => {
    await withGitFixture(async fx => {
      const work = cleanClone(fx);
      let first = true;
      const vanishing: GitRunner = async (cwd, args) => {
        if (first) { first = false; fs.rmSync(work, { recursive: true, force: true }); }
        return defaultGitRunner(cwd, args);
      };
      const r = await read(work, vanishing);
      assert.deepStrictEqual(r, { dirName: '-dir-repo', name: 'repo', path: work, state: 'missing' });
    });
  }));

  console.log(`\ngit-stats: ${ok_}/${total} passed`);
  return total - ok_;
}
