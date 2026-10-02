/**
 * `server/lib/git-fetch.ts`: the classifier, the detached runner and `fetchAll` (spec `docs/superpowers/specs/2026-10-02-git-fetch-design.md` §1, §5).
 * Every repo is real and built by `test/git-fixture.ts`; a fetch runs against a local bare repo through the real runner, wrapped in a spy that records
 * `(cwd, args, env)` and answers a canned result where a case needs one.
 *
 * `fetchAll` reads its pins from `getPinnedProjects()` through `listPinRows`, so `withGitFetch` gives each case a tmp cwd (the settings store is
 * cwd-relative) and a tmp `$HOME` (the transcripts hang off it), turns the Claude-root filter off, and restores the runner, the clock override, the
 * settings and the module's own state either side. A case plants one transcript per repo and pins it with `setPinned`.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';
import type { Config } from '../server/lib/config.js';
import {
  FETCH_ARGS, classifyFetchError, fetchAll, getFetchClock, lastFetchFor, makeFetchRunner, overrideFetchClock, overrideFetchRunner, resetGitFetch,
} from '../server/lib/git-fetch.js';
import type { FetchRunner } from '../server/lib/git-fetch.js';
import { gitStatsMemoKeys, readGitStats } from '../server/lib/git-stats.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';
import type { FetchError, GitStatsResponse } from '../shared/types.js';
import { GitFixture, withGitFixture } from './git-fixture.js';

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn()
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

interface Call { cwd: string; args: string[]; env: Record<string, string> }
type Answer = Awaited<ReturnType<FetchRunner>>;

interface Spy {
  run: FetchRunner;
  calls: Call[];
  /** The `git fetch` calls only. */
  fetches(): Call[];
}

const isFetch = (c: Call): boolean => c.args.includes('fetch');
const answer = (code: number, stderr = '', stdout = ''): Promise<Answer> => Promise.resolve({ code, stdout, stderr, timedOut: false });

/** Wraps the real runner and records every call. `canned` may answer a call itself; returning `undefined` delegates to git. */
function spy(canned?: (c: Call) => Promise<Answer> | undefined): Spy {
  const inner = makeFetchRunner();
  const calls: Call[] = [];
  const run: FetchRunner = (cwd, args, env) => {
    const c = { cwd, args, env };
    calls.push(c);
    return canned?.(c) ?? inner(cwd, args, env);
  };
  return { run, calls, fetches: () => calls.filter(isFetch) };
}

interface Ctx {
  fx: GitFixture;
  home: string;
  cfg: Config;
  /** Plants a transcript whose records carry `cwd`, and pins its project. */
  pin(cwd: string): void;
  unpin(cwd: string): void;
}

async function withGitFetch(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-fetch-')));
  try {
    await withGitFixture(async fx => {
      process.chdir(home);
      process.env.HOME = home;
      resetSettings();
      await resetGitFetch();
      overrideFetchRunner(null);
      fs.writeFileSync(path.join(home, '.env'), 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n');
      const cfg = loadConfig({ envPath: path.join(home, '.env') });
      const dirOf = (cwd: string): string => encodeProjectDir(cwd);
      const ctx: Ctx = {
        fx, home, cfg,
        pin(cwd) {
          const dir = path.join(home, '.claude', 'projects', dirOf(cwd));
          fs.mkdirSync(dir, { recursive: true });
          const rec = { uuid: 'u1', type: 'user', entrypoint: 'cli', cwd, timestamp: '2026-07-01T10:00:00Z', message: { role: 'user', content: 'hi' } };
          fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), JSON.stringify(rec) + '\n');
          assert.ok(setPinned(dirOf(cwd), true), 'pin refused');
        },
        unpin(cwd) { setPinned(dirOf(cwd), false); },
      };
      try {
        await fn(ctx);
      } finally {
        overrideFetchRunner(null);
        overrideFetchClock(null);
        await resetGitFetch();
        resetSettings();
        process.chdir(prevCwd);
      }
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    overrideClaudeRoots(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A bare origin `o.git` and a clone of it at `rel`. */
function cloneOf(fx: GitFixture, rel: string, bareRel = `${rel}-origin.git`): string {
  return fx.clone(fx.bare(bareRel), rel);
}

export async function run(): Promise<number> {
  let total = 0;
  let ok_ = 0;
  const check = (r: boolean): void => { total++; if (r) ok_++; };

  check(await test('1. a fetch moves origin/main and touches no Git Stats memo entry; the next read counts the new commit', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const o = fx.bare('o.git');
      const a = fx.clone(o, 'a');
      pin(a);
      const scratch = fx.clone(o, 'scratch');
      fx.commit(scratch, 'one ahead');
      fx.git(scratch, ['push', '-q', 'origin', 'main']);

      const before = await readGitStats(cfg);
      const r0 = before.repos[0];
      assert.strictEqual(r0.state, 'ok');
      assert.strictEqual((r0 as Extract<typeof r0, { state: 'ok' }>).trunkVsOrigin?.behind, 0);
      const keys = gitStatsMemoKeys();
      assert.ok(keys.length > 0, 'the read should have filled the memo');

      await fetchAll(cfg);
      assert.deepStrictEqual(gitStatsMemoKeys(), keys);

      const after: GitStatsResponse = await readGitStats(cfg);
      const r1 = after.repos[0];
      assert.strictEqual((r1 as Extract<typeof r1, { state: 'ok' }>).trunkVsOrigin?.behind, 1);
    });
  }));

  check(await test('2. two concurrent fetchAll calls are one promise and one fetch per repo', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const a = cloneOf(fx, 'a');
      const b = cloneOf(fx, 'b');
      pin(a); pin(b);
      const s = spy();
      overrideFetchRunner(s.run);
      const p1 = fetchAll(cfg);
      const p2 = fetchAll(cfg);
      assert.strictEqual(p1, p2);
      await p1;
      assert.deepStrictEqual(s.fetches().map(c => c.cwd).sort(), [a, b].sort());
      // The slot is free again once the first has ended.
      await fetchAll(cfg);
      assert.strictEqual(s.fetches().length, 4);
    });
  }));

  check(await test('3. a repo and its linked worktree, both pinned, are one fetch with one verdict', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const a = cloneOf(fx, 'a');
      const wt = fx.p('a-wt');
      fx.git(a, ['worktree', 'add', '-q', '-b', 'wt', wt]);
      pin(a); pin(wt);
      const s = spy();
      overrideFetchRunner(s.run);
      await fetchAll(cfg);
      assert.strictEqual(s.fetches().length, 1);
      const la = lastFetchFor(a);
      assert.ok(la && la.error === null, JSON.stringify(la));
      assert.deepStrictEqual(lastFetchFor(wt), la);
    });
  }));

  check(await test('4. no origin → no fetch and no entry; an auth failure is recorded; a vanished origin clears it again', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const solo = fx.init('solo');
      fx.commit(solo, 'root');
      const a = cloneOf(fx, 'a');
      pin(solo); pin(a);

      const s1 = spy();
      overrideFetchRunner(s1.run);
      await fetchAll(cfg);
      assert.deepStrictEqual(s1.fetches().map(c => c.cwd), [a]);
      assert.strictEqual(lastFetchFor(solo), null);
      assert.strictEqual(lastFetchFor(a)?.error, null);

      const s2 = spy(c => (isFetch(c) && c.cwd === a ? answer(128, 'git@host: Permission denied (publickey).\n') : undefined));
      overrideFetchRunner(s2.run);
      await fetchAll(cfg);
      assert.strictEqual(lastFetchFor(a)?.error, 'auth');

      const s3 = spy(c => (c.args[0] === 'remote' && c.cwd === a ? answer(0, '', '') : undefined));
      overrideFetchRunner(s3.run);
      await fetchAll(cfg);
      assert.strictEqual(s3.fetches().length, 0);
      assert.strictEqual(lastFetchFor(a), null);
    });
  }));

  check(await test('4b. a failing git remote or git config skips the group and clears its entry', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const a = cloneOf(fx, 'a');
      pin(a);
      overrideFetchRunner(spy().run);
      await fetchAll(cfg);
      assert.ok(lastFetchFor(a));

      const remoteFails = spy(c => (c.args[0] === 'remote' ? answer(128, 'fatal: boom') : undefined));
      overrideFetchRunner(remoteFails.run);
      await fetchAll(cfg);
      assert.strictEqual(remoteFails.fetches().length, 0);
      assert.strictEqual(lastFetchFor(a), null);

      overrideFetchRunner(spy().run);
      await fetchAll(cfg);
      assert.ok(lastFetchFor(a));
      const configFails = spy(c => (c.args[0] === 'config' ? answer(2, 'error: invalid key') : undefined));
      overrideFetchRunner(configFails.run);
      await fetchAll(cfg);
      assert.strictEqual(configFails.fetches().length, 0);
      assert.strictEqual(lastFetchFor(a), null);

      // A rejection is a skip too, never an escape.
      overrideFetchRunner(spy().run);
      await fetchAll(cfg);
      const rejects = spy(c => (c.args[0] === 'config' ? Promise.reject(new Error('spawn git ENOENT')) : undefined));
      overrideFetchRunner(rejects.run);
      await fetchAll(cfg);
      assert.strictEqual(rejects.fetches().length, 0);
      assert.strictEqual(lastFetchFor(a), null);
    });
  }));

  check(await test('5. classifyFetchError: one assertion per pattern, case-insensitive, timeout first, anything else other', async () => {
    const table: Array<[string, FetchError]> = [
      ['PERMISSION DENIED (PUBLICKEY)', 'auth'],
      ['git@host: Permission denied (publickey,keyboard-interactive).', 'auth'],
      ['remote: Authentication failed for', 'auth'],
      ['fatal: could not read Username for \'https://x\'', 'auth'],
      ['fatal: terminal prompts disabled', 'auth'],
      ['Host key verification failed.', 'auth'],
      ['fatal: unable to access: Could not resolve host: github.com', 'offline'],
      ['ssh: connect to host x port 22: Network is unreachable', 'offline'],
      ['ssh: connect to host x port 22: Connection refused', 'offline'],
      ['ssh: connect to host x port 22: Connection timed out', 'offline'],
      ['fatal: Could not connect to server', 'offline'],
      ['fatal: Couldn\'t connect to server', 'offline'],
      ['fatal: unable to access \'http://127.0.0.1:1/r.git/\': Failed to connect to 127.0.0.1 port 1 after 1 ms: Couldn\'t connect to server', 'offline'],
      ['Failed to connect to github.com port 443', 'offline'],
      ['ssh: connect to host x port 22: No route to host', 'offline'],
      ['error: cannot lock ref \'refs/remotes/origin/main\': is at x but expected y', 'lock'],
      ['fatal: Unable to create \'/r/.git/refs/remotes/origin/main.lock\': File exists.', 'lock'],
      ['error: unable to create /r/.git/FETCH_HEAD.lock', 'lock'],
      ['something new', 'other'],
      ['', 'other'],
    ];
    for (const [stderr, want] of table) assert.strictEqual(classifyFetchError(stderr, false), want, stderr);
    assert.strictEqual(classifyFetchError('Permission denied (publickey).', true), 'timeout');
    assert.strictEqual(classifyFetchError('', true), 'timeout');
  }));

  check(await test('6. the fetch call carries the argv, the no-prompt overlay and the ssh rule', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const a = cloneOf(fx, 'a');
      pin(a);
      const fetchEnv = async (): Promise<Record<string, string>> => {
        const s = spy();
        overrideFetchRunner(s.run);
        await fetchAll(cfg);
        const [f] = s.fetches();
        assert.ok(f, 'no fetch call');
        assert.deepStrictEqual(f.args, [...FETCH_ARGS]);
        return f.env;
      };
      const saved = { cmd: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH };
      try {
        delete process.env.GIT_SSH_COMMAND;
        delete process.env.GIT_SSH;

        const clean = await fetchEnv();
        assert.strictEqual(clean.GIT_TERMINAL_PROMPT, '0');
        assert.strictEqual(clean.GIT_ASKPASS, '');
        assert.strictEqual(clean.SSH_ASKPASS, '');
        assert.strictEqual(clean.LC_ALL, 'C');
        assert.strictEqual(clean.GIT_OPTIONAL_LOCKS, '0');
        assert.strictEqual(clean.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');

        process.env.GIT_SSH_COMMAND = 'x';
        assert.ok(!('GIT_SSH_COMMAND' in (await fetchEnv())));
        delete process.env.GIT_SSH_COMMAND;

        process.env.GIT_SSH = 'x';
        assert.ok(!('GIT_SSH_COMMAND' in (await fetchEnv())));
        delete process.env.GIT_SSH;

        fx.git(a, ['config', 'core.sshCommand', 'ssh -v']);
        assert.ok(!('GIT_SSH_COMMAND' in (await fetchEnv())));
      } finally {
        if (saved.cmd === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved.cmd;
        if (saved.ssh === undefined) delete process.env.GIT_SSH; else process.env.GIT_SSH = saved.ssh;
      }
    });
  }));

  check(await test('7. the clock reads idle, shows a running fetch, then its end', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      assert.deepStrictEqual(getFetchClock(), { intervalSecs: 0, nextAtMs: null, runningSinceMs: null, lastEndedMs: null });
      const a = cloneOf(fx, 'a');
      pin(a);
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const s = spy(c => (isFetch(c) ? gate.then(() => answer(0)) : undefined));
      overrideFetchRunner(s.run);
      const started = Date.now();
      const p = fetchAll(cfg);
      // The pin is resolved and the fetch reached before the gate is the thing waited on.
      while (s.fetches().length === 0) await new Promise(r => setTimeout(r, 5));
      const during = getFetchClock();
      assert.strictEqual(typeof during.runningSinceMs, 'number');
      assert.ok(during.runningSinceMs! >= started);
      assert.strictEqual(during.lastEndedMs, null);
      release();
      const done = await p;
      assert.strictEqual(done.runningSinceMs, null);
      assert.strictEqual(typeof done.lastEndedMs, 'number');
      assert.ok(done.lastEndedMs! >= during.runningSinceMs!);
      assert.deepStrictEqual(getFetchClock(), done);
      assert.strictEqual(done.nextAtMs, null);
    });
  }));

  check(await test('11. a rejecting fetch is that group\'s "other"; the other group is untouched and the clock is cleared', async () => {
    await withGitFetch(async ({ fx, cfg, pin }) => {
      const a = cloneOf(fx, 'a');
      const b = cloneOf(fx, 'b');
      pin(a); pin(b);
      const s = spy(c => (isFetch(c) && c.cwd === a ? Promise.reject(new Error('spawn git ENOENT')) : undefined));
      overrideFetchRunner(s.run);
      const clock = await fetchAll(cfg);
      assert.strictEqual(lastFetchFor(a)?.error, 'other');
      assert.strictEqual(lastFetchFor(b)?.error, null);
      assert.strictEqual(clock.runningSinceMs, null);
      assert.strictEqual(getFetchClock().runningSinceMs, null);
    });
  }));

  check(await test('12. a timeout kills the whole process group, the grandchild included', async () => {
    if (process.platform === 'win32') { console.log('    skipped: detached process groups are POSIX'); return; }
    await withGitFixture(async fx => {
      const dir = fx.plain('kill');
      const selfPid = path.join(dir, 'self.pid');
      const childPid = path.join(dir, 'child.pid');
      const script = path.join(dir, 'hang.sh');
      fs.writeFileSync(script, `#!/bin/sh\necho $$ > '${selfPid}'\nsleep 30 &\necho $! > '${childPid}'\nwait\n`);
      fs.chmodSync(script, 0o755);

      // A freshly written script can take over 200ms to start on macOS, and a group killed before the script wrote its pids proves nothing, so the
      // timeout leaves room for the start and the bound below is on the kill, not on the start.
      const timeoutMs = 600;
      const t0 = Date.now();
      const r = await makeFetchRunner({ timeoutMs, bin: script })(dir, [], {});
      assert.strictEqual(r.timedOut, true);
      assert.ok(Date.now() - t0 < timeoutMs + 1000, `took ${Date.now() - t0}ms`);

      const pids = [selfPid, childPid].map(f => Number(fs.readFileSync(f, 'utf8').trim()));
      assert.ok(pids.every(p => p > 0), `bad pids ${pids}`);
      const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; } };
      for (let i = 0; i < 20 && !pids.every(gone); i++) await new Promise(res => setTimeout(res, 50));
      assert.deepStrictEqual(pids.map(gone), [true, true]);
    });
  }));

  check(await test('12b. a missing binary rejects; a normal exit resolves with its code and output', async () => {
    await withGitFixture(async fx => {
      await assert.rejects(makeFetchRunner({ bin: fx.p('no-such-bin') })(fx.root, [], {}));
      const r = await makeFetchRunner()(fx.root, ['--version'], {});
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.timedOut, false);
      assert.match(r.stdout, /^git version/);
      const bad = await makeFetchRunner()(fx.root, ['rev-parse', '--show-toplevel'], {});
      assert.notStrictEqual(bad.code, 0);
    });
  }));

  check(await test('Review Focus 4. an unpinned repo leaves no entry; the one still pinned keeps its own', async () => {
    await withGitFetch(async ({ fx, cfg, pin, unpin }) => {
      const a = cloneOf(fx, 'a');
      const b = cloneOf(fx, 'b');
      pin(a); pin(b);
      overrideFetchRunner(spy().run);
      await fetchAll(cfg);
      assert.ok(lastFetchFor(a) && lastFetchFor(b));
      unpin(b);
      await fetchAll(cfg);
      assert.strictEqual(lastFetchFor(b), null);
      assert.ok(lastFetchFor(a));
    });
  }));

  console.log(`\ngit-fetch: ${ok_}/${total} passed`);
  return total - ok_;
}
