/**
 * `server/lib/codegraph.ts`: the status parser, the graph-root walk, pid-file readers and `readCodegraphStatus` (spec
 * `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` §Data). Repos are tmpdirs holding an empty `.codegraph/codegraph.db`; the CLI is a fake runner.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODEGRAPH_ENV,
  CODEGRAPH_STATUS_TIMEOUT_MS,
  LOCK_LOSS_TEXT,
  currentCodegraphRunner,
  defaultCodegraphRunner,
  findGraphRoot,
  isPidAlive,
  livePid,
  makeCodegraphRunner,
  overrideCodegraphRunner,
  parseCodegraphStatus,
  readCodegraphStatus,
  readPidFile,
} from '../server/lib/codegraph.js';
import type { CodegraphRunner } from '../server/lib/codegraph.js';
import type { PinRow } from '../shared/types.js';

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn()
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

const FIXTURE = fs.readFileSync(new URL('./fixtures/codegraph-status-1.6.2.json', import.meta.url), 'utf8');

function pin(p: string | null, over: Partial<PinRow> = {}): PinRow {
  return { dirName: '-dir-repo', name: 'repo', path: p, lastActiveMs: null, listed: true, ...over };
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codegraph-test-')));
  try { await fn(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}

/** A repo folder with an indexed (empty) DB. */
function indexedRepo(dir: string, name = 'repo'): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codegraph', 'codegraph.db'), '');
  return repo;
}

/** The pid of a process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    child.on('error', reject);
    child.on('exit', () => resolve(pid));
  });
}

interface Fake {
  run: CodegraphRunner;
  calls: { cwd: string; args: string[]; timeoutMs: number | null }[];
}

/** A runner that records its calls and answers with `answer`. */
function fake(answer: (cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>): Fake {
  const f: Fake = { calls: [], run: async () => ({ code: 0, stdout: '', stderr: '' }) };
  f.run = (cwd, args, timeoutMs) => { f.calls.push({ cwd, args, timeoutMs }); return answer(cwd); };
  return f;
}

const okAnswer = async () => ({ code: 0, stdout: FIXTURE, stderr: '' });

function rejecting(code: string, before?: () => void): (cwd: string) => Promise<never> {
  return async () => {
    before?.();
    throw Object.assign(new Error(code), { code });
  };
}

export async function run(): Promise<number> {
  let total = 0;
  let ok_ = 0;
  const check = (passed: boolean) => { total++; if (passed) ok_++; };
  console.log('\ncodegraph');

  check(await test('parseCodegraphStatus: the 1.6.2 capture, extra fields ignored', async () => {
    const s = parseCodegraphStatus(FIXTURE);
    assert.ok(s !== 'uninitialized');
    assert.strictEqual(s.fileCount, 416);
    assert.strictEqual(s.nodeCount, 8254);
    assert.strictEqual(s.edgeCount, 33969);
    assert.strictEqual(s.dbSizeBytes, 36786176);
    assert.strictEqual(s.indexState, 'complete');
    assert.strictEqual(s.builtWithVersion, '1.6.2');
    assert.strictEqual(s.builtWithExtractionVersion, 27);
    assert.strictEqual(s.currentExtractionVersion, 27);
    assert.strictEqual(s.reindexRecommended, false);
    assert.deepStrictEqual(s.pending, { added: 0, modified: 0, removed: 0 });
    assert.strictEqual(s.worktreeMismatch, null);
    assert.deepStrictEqual(s.languages, ['javascript', 'tsx', 'typescript', 'yaml']);
    assert.strictEqual(s.lastIndexedMs, Date.parse('2026-10-19T08:14:07.660Z'));
    assert.strictEqual(s.version, '1.6.2');
    assert.strictEqual(s.nodesByKind.function, 2637);
    assert.ok(!('walSizeBytes' in s) && !('projectPath' in s), 'raw CLI fields must not leak through');
  }));

  check(await test('parseCodegraphStatus: index.state null reads complete; absent stamps read null', async () => {
    const j = JSON.parse(FIXTURE);
    j.index = { ...j.index, state: null };
    delete j.index.builtWithVersion;
    j.index.builtWithExtractionVersion = null;
    const s = parseCodegraphStatus(JSON.stringify(j));
    assert.ok(s !== 'uninitialized');
    assert.strictEqual(s.indexState, 'complete');
    assert.strictEqual(s.builtWithVersion, null);
    assert.strictEqual(s.builtWithExtractionVersion, null);
    delete j.index;
    const bare = parseCodegraphStatus(JSON.stringify(j));
    assert.ok(bare !== 'uninitialized');
    assert.strictEqual(bare.indexState, 'complete');
    assert.strictEqual(bare.builtWithExtractionVersion, null);
    assert.strictEqual(bare.currentExtractionVersion, null);
    assert.strictEqual(bare.reindexRecommended, false);
  }));

  check(await test('parseCodegraphStatus: a worktreeMismatch and a non-complete state pass through; a null lastIndexed stays null', async () => {
    const j = JSON.parse(FIXTURE);
    j.worktreeMismatch = { worktreeRoot: '/repo/.claude/worktrees/x', indexRoot: '/repo' };
    j.index = { ...j.index, state: 'partial', reindexRecommended: true };
    j.lastIndexed = null;
    const s = parseCodegraphStatus(JSON.stringify(j));
    assert.ok(s !== 'uninitialized');
    assert.deepStrictEqual(s.worktreeMismatch, { worktreeRoot: '/repo/.claude/worktrees/x', indexRoot: '/repo' });
    assert.strictEqual(s.indexState, 'partial');
    assert.strictEqual(s.reindexRecommended, true);
    assert.strictEqual(s.lastIndexedMs, null);
  }));

  check(await test('parseCodegraphStatus: uninitialized, and a one-line reason for anything unusable', async () => {
    assert.strictEqual(parseCodegraphStatus('{"initialized":false}'), 'uninitialized');
    for (const bad of ['', 'not json', '{}', '[]', 'null']) {
      assert.throws(() => parseCodegraphStatus(bad), (e: Error) => e instanceof Error && e.message !== '' && !e.message.includes('\n'), JSON.stringify(bad));
    }
    const j = JSON.parse(FIXTURE);
    delete j.nodeCount;
    assert.throws(() => parseCodegraphStatus(JSON.stringify(j)), /nodeCount/);
  }));

  check(await test('findGraphRoot: the dir itself, then an ancestor, never a bare .codegraph/', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
      assert.strictEqual(await findGraphRoot(repo), repo);
      assert.strictEqual(await findGraphRoot(path.join(repo, 'a', 'b')), repo);
      const bare = path.join(dir, 'bare');
      fs.mkdirSync(path.join(bare, '.codegraph'), { recursive: true });
      assert.strictEqual(await findGraphRoot(bare), null);
    });
  }));

  check(await test('findGraphRoot: a codegraph.db that is a directory does not count', async () => {
    await withTmp(async dir => {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(path.join(repo, '.codegraph', 'codegraph.db'), { recursive: true });
      assert.strictEqual(await findGraphRoot(repo), null);
    });
  }));

  check(await test('findGraphRoot: a live rebuild.pid stands in for a DB that is briefly absent; a dead one does not', async () => {
    await withTmp(async dir => {
      const live = path.join(dir, 'live');
      fs.mkdirSync(path.join(live, '.codegraph'), { recursive: true });
      fs.writeFileSync(path.join(live, '.codegraph', 'rebuild.pid'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      assert.strictEqual(await findGraphRoot(live), live);
      const dead = path.join(dir, 'dead');
      fs.mkdirSync(path.join(dead, '.codegraph'), { recursive: true });
      fs.writeFileSync(path.join(dead, '.codegraph', 'rebuild.pid'), JSON.stringify({ pid: await deadPid(), startedAt: 1 }));
      assert.strictEqual(await findGraphRoot(dead), null);
    });
  }));

  check(await test('readPidFile: JSON object, bare integer, absent, garbage', async () => {
    await withTmp(async dir => {
      const f = path.join(dir, 'x.pid');
      fs.writeFileSync(f, JSON.stringify({ pid: 4242, startedAt: 1760000000000, extra: 'x' }));
      assert.deepStrictEqual(await readPidFile(f), { pid: 4242, startedAtMs: 1760000000000 });
      fs.writeFileSync(f, JSON.stringify({ pid: 4242 }));
      assert.deepStrictEqual(await readPidFile(f), { pid: 4242, startedAtMs: null });
      fs.writeFileSync(f, '12345\n');
      assert.deepStrictEqual(await readPidFile(f), { pid: 12345, startedAtMs: null });
      assert.strictEqual(await readPidFile(path.join(dir, 'missing.pid')), null);
      for (const junk of ['', 'garbage', '{"pid":"x"}', '{not json', '-3', '0', '{"pid":1.5}']) {
        fs.writeFileSync(f, junk);
        assert.strictEqual(await readPidFile(f), null, JSON.stringify(junk));
      }
    });
  }));

  check(await test('isPidAlive / livePid: our own pid is alive, an exited one is not', async () => {
    await withTmp(async dir => {
      assert.strictEqual(isPidAlive(process.pid), true);
      const dead = await deadPid();
      assert.strictEqual(isPidAlive(dead), false);
      const f = path.join(dir, 'p.pid');
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, startedAt: 7 }));
      assert.deepStrictEqual(await livePid(f), { pid: process.pid, startedAtMs: 7 });
      fs.writeFileSync(f, JSON.stringify({ pid: dead, startedAt: 7 }));
      assert.strictEqual(await livePid(f), null);
      assert.strictEqual(await livePid(path.join(dir, 'none.pid')), null);
    });
  }));

  check(await test('readCodegraphStatus: dead pins never reach the runner, whatever is on disk', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const f = fake(okAnswer);
      assert.deepStrictEqual(await readCodegraphStatus(pin(null), f.run), { kind: 'missing' });
      assert.deepStrictEqual(await readCodegraphStatus(pin(repo, { listed: false }), f.run), { kind: 'missing' });
      assert.deepStrictEqual(await readCodegraphStatus(pin(path.join(dir, 'gone')), f.run), { kind: 'missing' });
      assert.deepStrictEqual(f.calls, []);
    });
  }));

  check(await test('readCodegraphStatus: no graph root → none, runner never called', async () => {
    await withTmp(async dir => {
      const plain = path.join(dir, 'plain');
      fs.mkdirSync(plain);
      const f = fake(okAnswer);
      assert.deepStrictEqual(await readCodegraphStatus(pin(plain), f.run), { kind: 'none' });
      assert.deepStrictEqual(f.calls, []);
    });
  }));

  check(await test('readCodegraphStatus: a subdirectory pin runs from the pin path and reports the repo root', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const sub = path.join(repo, 'packages', 'web');
      fs.mkdirSync(sub, { recursive: true });
      const f = fake(okAnswer);
      const r = await readCodegraphStatus(pin(sub), f.run);
      assert.strictEqual(r.kind, 'ok');
      if (r.kind !== 'ok') return;
      assert.strictEqual(r.root, repo);
      assert.strictEqual(r.stats.fileCount, 416);
      assert.deepStrictEqual(f.calls, [{ cwd: sub, args: ['status', '--json'], timeoutMs: CODEGRAPH_STATUS_TIMEOUT_MS }]);
    });
  }));

  check(await test('readCodegraphStatus: a non-zero exit reads stderr\'s last non-empty line, else stdout\'s, else the code', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const cases: [{ code: number; stdout: string; stderr: string }, string][] = [
        [{ code: 2, stdout: 'out line\n', stderr: 'first\nsecond\n\n' }, 'second'],
        [{ code: 2, stdout: 'a\nout line\n\n', stderr: '  \n' }, 'out line'],
        [{ code: 3, stdout: '', stderr: '' }, 'exit 3'],
      ];
      for (const [answer, message] of cases) {
        const r = await readCodegraphStatus(pin(repo), fake(async () => answer).run);
        assert.deepStrictEqual(r, { kind: 'error', root: repo, message });
      }
    });
  }));

  check(await test('readCodegraphStatus: unparsable stdout on exit 0 → error with the parser\'s reason', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const r = await readCodegraphStatus(pin(repo), fake(async () => ({ code: 0, stdout: 'not json', stderr: '' })).run);
      assert.strictEqual(r.kind, 'error');
      if (r.kind !== 'error') return;
      assert.strictEqual(r.root, repo);
      assert.strictEqual(r.message, (() => { try { parseCodegraphStatus('not json'); } catch (e) { return (e as Error).message; } return ''; })());
      assert.ok(r.message !== '');
    });
  }));

  check(await test('readCodegraphStatus: ETIMEDOUT → error "codegraph status timed out"', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const r = await readCodegraphStatus(pin(repo), fake(rejecting('ETIMEDOUT')).run);
      assert.deepStrictEqual(r, { kind: 'error', root: repo, message: 'codegraph status timed out' });
    });
  }));

  check(await test('readCodegraphStatus: ENOENT with the folder present is a missing CLI; with the folder gone it is that repo missing', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      assert.deepStrictEqual(await readCodegraphStatus(pin(repo), fake(rejecting('ENOENT')).run), { kind: 'cli-missing' });

      const doomed = indexedRepo(dir, 'doomed');
      const r = await readCodegraphStatus(pin(doomed), fake(rejecting('ENOENT', () => fs.rmSync(doomed, { recursive: true, force: true }))).run);
      assert.deepStrictEqual(r, { kind: 'missing' });
    });
  }));

  check(await test('readCodegraphStatus: another spawn failure → error with its message', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const r = await readCodegraphStatus(pin(repo), fake(rejecting('EACCES')).run);
      assert.deepStrictEqual(r, { kind: 'error', root: repo, message: 'EACCES' });
    });
  }));

  check(await test('readCodegraphStatus: initialized:false in the answer → none', async () => {
    await withTmp(async dir => {
      const repo = indexedRepo(dir);
      const r = await readCodegraphStatus(pin(repo), fake(async () => ({ code: 0, stdout: '{"initialized":false}', stderr: '' })).run);
      assert.deepStrictEqual(r, { kind: 'none' });
    });
  }));

  check(await test('runner seam: override, restore, and the constants the rest of the server leans on', async () => {
    const f = fake(okAnswer);
    try {
      overrideCodegraphRunner(f.run);
      assert.strictEqual(currentCodegraphRunner(), f.run);
    } finally {
      overrideCodegraphRunner(null);
    }
    assert.strictEqual(currentCodegraphRunner(), defaultCodegraphRunner);
    assert.strictEqual(CODEGRAPH_ENV.CODEGRAPH_NO_UPDATE_CHECK, '1');
    assert.strictEqual(CODEGRAPH_ENV.CODEGRAPH_NO_DOWNLOAD, '1');
    assert.strictEqual(CODEGRAPH_STATUS_TIMEOUT_MS, 15_000);
    assert.strictEqual(LOCK_LOSS_TEXT, 'could not acquire the file lock');
  }));

  check(await test('runner: a missing cwd rejects ENOENT (both launch shapes); a missing bin does too', async () => {
    await withTmp(async dir => {
      const gone = path.join(dir, 'gone');
      await assert.rejects(defaultCodegraphRunner(gone, ['status', '--json'], 5000), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
      await assert.rejects(defaultCodegraphRunner(gone, ['sync'], null), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
      await assert.rejects(makeCodegraphRunner('codegraph-no-such-bin')(dir, [], 5000), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
    });
  }));

  check(await test('runner: exit codes resolve with their output; a stalled child rejects ETIMEDOUT; a null timeout waits for the exit', async () => {
    await withTmp(async dir => {
      const node = makeCodegraphRunner(process.execPath);
      const out = await node(dir, ['-e', 'console.log("o"); console.error("e"); process.exit(3)'], 5000);
      assert.deepStrictEqual(out, { code: 3, stdout: 'o\n', stderr: 'e\n' });
      const started = Date.now();
      await assert.rejects(node(dir, ['-e', 'setTimeout(() => {}, 20000)'], 300), (e: NodeJS.ErrnoException) => e.code === 'ETIMEDOUT');
      assert.ok(Date.now() - started < 10_000, 'the timer, not the child, ended the wait');
      const slow = await node(dir, ['-e', 'setTimeout(() => { console.log("late"); process.exit(4); }, 200)'], null);
      assert.deepStrictEqual(slow, { code: 4, stdout: 'late\n', stderr: '' });
    });
  }));

  console.log(`\ncodegraph: ${ok_}/${total} passed`);
  return total - ok_;
}
