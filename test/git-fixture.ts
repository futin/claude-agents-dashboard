/**
 * Real git repos in a tmpdir for the Git Stats tests (`server/lib/git-stats.ts`). No git output is mocked: every fixture is built by the git binary.
 *
 * Fixture commands run with the machine's global and system config switched off and every identity and date pinned, so a global hook, template, signing
 * rule or default branch on this machine cannot change what a fixture looks like. The reader under test still runs with the real config, as it does live.
 * "Cloned" means a clone of a local bare repo: `origin` exists and fixture fetches stay on disk.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** First commit's date; each later commit is a minute newer unless the caller pins one. */
const EPOCH_SEC = 1_700_000_000;

export class GitFixture {
  /** Realpath of the tmpdir, so it compares equal to what `git rev-parse --show-toplevel` prints (macOS `/var` is a symlink to `/private/var`). */
  readonly root: string;
  private clock = EPOCH_SEC;

  constructor() {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-git-')));
  }

  /** Absolute path of `rel` under the fixture root. */
  p(rel: string): string {
    return path.join(this.root, rel);
  }

  /** Run git in `cwd` with the pinned env; returns trimmed stdout. Throws on a non-zero exit unless `allowFail`. */
  git(cwd: string, args: string[], opts: { allowFail?: boolean; dateSec?: number } = {}): string {
    const date = `@${opts.dateSec ?? this.clock} +0000`;
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
    };
    const full = ['-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args];
    try {
      return execFileSync('git', full, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (opts.allowFail) return String((e as { stdout?: string }).stdout ?? '').trim();
      throw e;
    }
  }

  /** Write `files` (rel path → content) under `cwd`, stage everything and commit. Advances the clock unless `dateSec` is given. */
  commit(cwd: string, msg: string, files: Record<string, string> = { [`${msg.replace(/\W+/g, '-')}.txt`]: msg }, dateSec?: number): void {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), content);
    }
    this.git(cwd, ['add', '-A']);
    this.git(cwd, ['commit', '-q', '-m', msg], { dateSec });
    if (dateSec === undefined) this.clock += 60;
  }

  /** `git init -b <branch>` at `rel`; returns its path. */
  init(rel: string, branch = 'main'): string {
    const dir = this.p(rel);
    fs.mkdirSync(dir, { recursive: true });
    this.git(dir, ['init', '-q', '-b', branch]);
    return dir;
  }

  /**
   * A bare repo at `rel` holding `branches` (each one commit on top of the first branch's commit), with HEAD on `head`. Built through a scratch seed repo
   * that is deleted afterwards. Returns the bare repo's path.
   */
  bare(rel: string, branches: string[] = ['main'], head = branches[0]): string {
    const dir = this.p(rel);
    this.git(this.root, ['init', '-q', '--bare', '-b', head, dir]);
    const seed = this.init(`${rel}.seed`, branches[0]);
    this.commit(seed, `${branches[0]} root`);
    for (const b of branches.slice(1)) {
      this.git(seed, ['checkout', '-q', '-b', b, branches[0]]);
      this.commit(seed, `${b} tip`);
    }
    this.git(seed, ['push', '-q', dir, ...branches.map(b => `refs/heads/${b}:refs/heads/${b}`)]);
    fs.rmSync(seed, { recursive: true, force: true });
    return dir;
  }

  /** `git clone <bare> <rel>`; returns the clone's path. */
  clone(bare: string, rel: string): string {
    const dir = this.p(rel);
    this.git(this.root, ['clone', '-q', bare, dir]);
    return dir;
  }

  /** A plain (non-git) folder at `rel`. */
  plain(rel: string): string {
    const dir = this.p(rel);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** Run `fn` against a fresh fixture and always clean it up. */
export async function withGitFixture<T>(fn: (fx: GitFixture) => Promise<T>): Promise<T> {
  const fx = new GitFixture();
  try {
    return await fn(fx);
  } finally {
    fx.cleanup();
  }
}
