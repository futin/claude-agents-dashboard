/**
 * `server/lib/git-stats.ts`, repo-level facts (spec `docs/superpowers/specs/2026-10-01-git-stats-design.md` §2, §7). Every repo is real and built by
 * `test/git-fixture.ts`; the reader runs through the real git runner wrapped in a spy that counts calls and in-flight overlap.
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

/** A clone of a one-commit `main` origin. */
function cleanClone(fx: GitFixture): string {
  return fx.clone(fx.bare('origin.git'), 'work');
}

export async function run(): Promise<number> {
  console.log('\n=== git-stats: repo-level facts ===\n');
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
          hasOrigin: r.hasOrigin, trunkVsOrigin: r.trunkVsOrigin, branches: r.branches,
        },
        { branch: 'main', detachedSha: null, trunk: null, onTrunk: false, hasOrigin: false, trunkVsOrigin: null, branches: [] },
      );
    });
  }));

  check(await test('no remote, branch master → trunk master, hasOrigin false, trunkVsOrigin null', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('legacy', 'master');
      fx.commit(repo, 'first');
      const r = ok(await read(repo));
      assert.deepStrictEqual(
        { trunk: r.trunk, hasOrigin: r.hasOrigin, trunkVsOrigin: r.trunkVsOrigin, onTrunk: r.onTrunk },
        { trunk: 'master', hasOrigin: false, trunkVsOrigin: null, onTrunk: true },
      );
    });
  }));

  check(await test('only branch dev, no origin → trunk null', async () => {
    await withGitFixture(async fx => {
      const repo = fx.init('devonly', 'dev');
      fx.commit(repo, 'first');
      const r = ok(await read(repo));
      assert.strictEqual(r.trunk, null);
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
        { trunk: r.trunk, trunkVsOrigin: r.trunkVsOrigin, onTrunk: r.onTrunk, branch: r.branch },
        { trunk: 'develop', trunkVsOrigin: null, onTrunk: false, branch: 'feature' },
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

  console.log(`\ngit-stats: ${ok_}/${total} passed`);
  return total - ok_;
}
