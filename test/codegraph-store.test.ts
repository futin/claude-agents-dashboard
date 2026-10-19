/**
 * `server/lib/codegraph-store.ts`: the status cache, the per-GET pid reads and the Sync/Reindex runs (spec `docs/superpowers/specs/2026-10-19-codegraph-view-design.md`
 * §Source, §Cost, §API, §Levels). The CLI is a fake runner and time is an injected clock, so a 25 s TTL costs nothing; nothing here spawns a process.
 *
 * Pins come from `setPinned` over planted transcripts whose `cwd` is a tmpdir repo, the way `api-git-fetch.test.ts` `plantProject` does. `$HOME` and cwd move
 * into a tmpdir for the whole file because settings are stored cwd-relative.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { userRecord } from './api-harness.js';
import { LOCK_LOSS_TEXT, overrideCodegraphRunner } from '../server/lib/codegraph.js';
import type { CodegraphRunner } from '../server/lib/codegraph.js';
import {
  CODEGRAPH_CONCURRENCY,
  CODEGRAPH_TTL_MS,
  WATCHER_SYNCING_TEXT,
  codegraphRunsSettled,
  readCodegraph,
  resetCodegraph,
  setCodegraphClock,
  startCodegraphRun,
} from '../server/lib/codegraph-store.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';
import type { CodegraphRepo, CodegraphResponse } from '../shared/types.js';

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn()
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

const FIXTURE = fs.readFileSync(new URL('./fixtures/codegraph-status-1.6.2.json', import.meta.url), 'utf8');
const LOCK_LINE = 'Failed to sync: Sync could not acquire the file lock; retry when the index is available.';

/** The fixture with a different `fileCount`, so a test can tell which read it is looking at. */
function statusWith(fileCount: number): string {
  return JSON.stringify({ ...JSON.parse(FIXTURE), fileCount });
}

interface Call { cwd: string; args: string[] }
interface Fake { run: CodegraphRunner; calls: Call[]; status(): number; runs(): Call[] }
type Answer = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A runner that records every call and answers with `answer` (default: a healthy 416-file repo for `status`, exit 0 for a run). */
function fake(answer?: Answer): Fake {
  const calls: Call[] = [];
  const fallback: Answer = async (_cwd, args) => ({ code: 0, stdout: args[0] === 'status' ? FIXTURE : '', stderr: '' });
  const run: CodegraphRunner = (cwd, args) => { calls.push({ cwd, args }); return (answer ?? fallback)(cwd, args); };
  return { run, calls, status: () => calls.filter(c => c.args[0] === 'status').length, runs: () => calls.filter(c => c.args[0] !== 'status') };
}

/** A runner whose run calls park until `release` is called, so a test can look at the repo mid-run. */
function parked(): Fake & { release(code?: number, stderr?: string): void } {
  const resolvers: ((r: { code: number; stdout: string; stderr: string }) => void)[] = [];
  const f = fake(async (_cwd, args) => {
    if (args[0] === 'status') return { code: 0, stdout: FIXTURE, stderr: '' };
    return new Promise(resolve => { resolvers.push(resolve); });
  });
  return Object.assign(f, { release: (code = 0, stderr = '') => { for (const r of resolvers.splice(0)) r({ code, stdout: '', stderr }); } });
}

function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    child.on('error', reject);
    child.on('exit', () => resolve(pid));
  });
}

let home = '';
let now = 0;
const START = 1_800_000_000_000;

interface Pinned { dir: string; dirName: string }

/** A pinned folder: a transcript with this `cwd`, then the pin. `indexed` gives it an (empty) `codegraph.db`. */
function pinned(dir: string, indexed: boolean): Pinned {
  fs.mkdirSync(dir, { recursive: true });
  if (indexed) {
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  }
  const dirName = encodeProjectDir(dir);
  const proj = path.join(home, '.claude', 'projects', dirName);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.jsonl'), JSON.stringify(userRecord('u1', 'hi', dir)) + '\n');
  setPinned(dirName, true);
  return { dir, dirName };
}

let seq = 0;
const repo = (name = `repo${seq++}`, indexed = true): Pinned => pinned(path.join(home, name), indexed);

function writePid(dir: string, file: string, pid: number, startedAt?: number): void {
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', file), startedAt === undefined ? String(pid) : JSON.stringify({ pid, startedAt }));
}

const get = (): Promise<CodegraphResponse> => readCodegraph({});

async function row(p: Pinned): Promise<CodegraphRepo> {
  const r = (await get()).repos.find(x => x.dirName === p.dirName);
  assert.ok(r, 'row for ' + p.dirName);
  return r;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Each case starts with no pins, a cold cache and the injected clock at START, and leaves the module that way. */
async function withEnv(fn: () => Promise<void>): Promise<void> {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codegraph-store-')));
  const prev = { cwd: process.cwd(), home: process.env.HOME };
  home = root;
  process.chdir(root);
  process.env.HOME = root;
  overrideClaudeRoots([]);
  resetSettings();
  resetCodegraph();
  now = START;
  setCodegraphClock(() => now);
  try {
    await fn();
  } finally {
    await codegraphRunsSettled();
    overrideCodegraphRunner(null);
    setCodegraphClock(null);
    resetCodegraph();
    resetSettings();
    overrideClaudeRoots(null);
    process.chdir(prev.cwd);
    if (prev.home === undefined) delete process.env.HOME; else process.env.HOME = prev.home;
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export async function run(): Promise<number> {
  let total = 0;
  let ok_ = 0;
  const check = (passed: boolean) => { total++; if (passed) ok_++; };
  const it = (name: string, fn: () => Promise<void>) => test(name, () => withEnv(fn)).then(check);
  console.log('\ncodegraph-store');

  await it('constants: TTL 25 s, two concurrent reads', async () => {
    assert.strictEqual(CODEGRAPH_TTL_MS, 25_000);
    assert.strictEqual(CODEGRAPH_CONCURRENCY, 2);
    assert.strictEqual(WATCHER_SYNCING_TEXT, 'watcher is syncing it');
  });

  await it('cache: cold GET reads each repo once; a second GET inside the TTL makes none', async () => {
    const a = repo(); const b = repo();
    const f = fake(); overrideCodegraphRunner(f.run);
    const first = await get();
    assert.strictEqual(f.status(), 2);
    assert.deepStrictEqual(f.calls.map(c => c.cwd).sort(), [a.dir, b.dir].sort());
    assert.ok(first.repos.every(r => r.state === 'ok'));
    now += CODEGRAPH_TTL_MS - 1;
    await get();
    assert.strictEqual(f.status(), 2, 'a fresh entry answers from the cache');
  });

  await it('cache: past the TTL the old stats are answered and exactly one background read starts, however many GETs ask', async () => {
    const a = repo();
    let answerFiles = 416;
    const f = fake(async (_c, args) => ({ code: 0, stdout: args[0] === 'status' ? statusWith(answerFiles) : '', stderr: '' }));
    overrideCodegraphRunner(f.run);
    await get();
    assert.strictEqual(f.status(), 1);
    answerFiles = 500;
    now += CODEGRAPH_TTL_MS + 1;
    const [x, y] = await Promise.all([get(), get()]);
    for (const res of [x, y]) {
      const r = res.repos[0];
      assert.ok(r.state === 'ok' && r.stats.fileCount === 416, 'the stale entry answers at once');
    }
    await codegraphRunsSettled();
    assert.strictEqual(f.status(), 2, 'two GETs after the TTL still make one background read');
    const after = await row(a);
    assert.ok(after.state === 'ok' && after.stats.fileCount === 500, 'the refresh replaced the entry');
    assert.strictEqual(f.status(), 2, 'and that entry is fresh again');
  });

  await it('cache: pins on one root each read from their own path and keep their own worktreeMismatch', async () => {
    const top = repo('mono');
    const sub = pinned(path.join(top.dir, '.claude', 'worktrees', 'wt'), false);
    const mismatch = { worktreeRoot: sub.dir, indexRoot: top.dir };
    const f = fake(async cwd => ({ code: 0, stdout: JSON.stringify({ ...JSON.parse(FIXTURE), worktreeMismatch: cwd === sub.dir ? mismatch : null }), stderr: '' }));
    overrideCodegraphRunner(f.run);
    const res = await get();
    assert.deepStrictEqual(f.calls.map(c => c.cwd).sort(), [top.dir, sub.dir].sort(), 'one read per pin path, each from its own path');
    const by = (p: Pinned) => res.repos.find(r => r.dirName === p.dirName)!;
    const [t, s] = [by(top), by(sub)];
    assert.ok(t.state === 'ok' && s.state === 'ok' && t.root === top.dir && s.root === top.dir, 'one root');
    assert.ok(t.state === 'ok' && t.stats.worktreeMismatch === null, 'the repo row is not told it is another worktree');
    assert.ok(s.state === 'ok' && s.stats.worktreeMismatch !== null && s.stats.worktreeMismatch.worktreeRoot === sub.dir);
    await get();
    assert.strictEqual(f.status(), 2, 'both entries are fresh inside the TTL');
  });

  await it('cache: pins on one root still share the run, the lastRun and the drop at run end', async () => {
    const top = repo('mono');
    const sub = pinned(path.join(top.dir, 'sub'), false);
    const f = parked(); overrideCodegraphRunner(f.run);
    await get();
    assert.strictEqual(f.status(), 2);
    assert.strictEqual(await startCodegraphRun({}, sub.dirName, 'sync'), 'started');
    const mid = (await get()).repos;
    assert.ok(mid.every(r => r.run !== null && r.run.kind === 'sync' && r.run.startedAtMs === mid[0].run!.startedAtMs), 'both rows show the one run');
    f.release(); await codegraphRunsSettled();
    const after = (await get()).repos;
    assert.strictEqual(f.status(), 4, 'the run ending dropped the entry of every pin on the root');
    assert.ok(after.every(r => r.run === null && r.lastRun !== null && r.lastRun.ok), 'and both rows carry the one lastRun');
  });

  await it('limiter: seven cold repos never run more than two reads at once', async () => {
    for (let i = 0; i < 7; i++) repo();
    let cur = 0; let peak = 0;
    const f = fake(async () => {
      cur++; peak = Math.max(peak, cur);
      await sleep(15);
      cur--;
      return { code: 0, stdout: FIXTURE, stderr: '' };
    });
    overrideCodegraphRunner(f.run);
    const res = await get();
    assert.strictEqual(f.status(), 7);
    assert.strictEqual(peak, CODEGRAPH_CONCURRENCY);
    assert.ok(res.repos.every(r => r.state === 'ok'));
  });

  await it('no GET, no read: there is no timer', async () => {
    repo();
    const f = fake(); overrideCodegraphRunner(f.run);
    now += CODEGRAPH_TTL_MS * 4;
    await sleep(30);
    assert.strictEqual(f.calls.length, 0);
  });

  await it('watcher: daemon.pid with a live pid is watching since its startedAt; a dead pid or no file is not', async () => {
    const live = repo(); const dead = repo(); const none = repo();
    writePid(live.dir, 'daemon.pid', process.pid, 1234);
    writePid(dead.dir, 'daemon.pid', await deadPid(), 99);
    overrideCodegraphRunner(fake().run);
    const res = await get();
    const by = (p: Pinned) => res.repos.find(r => r.dirName === p.dirName)!;
    assert.strictEqual(by(live).watching, true);
    assert.strictEqual(by(live).watcherSinceMs, 1234);
    assert.strictEqual(by(dead).watching, false);
    assert.strictEqual(by(dead).watcherSinceMs, null);
    assert.strictEqual(by(none).watching, false);
    assert.strictEqual(by(none).watcherSinceMs, null);
    for (const p of [live, dead, none]) { assert.strictEqual(by(p).rebuildLive, false); assert.strictEqual(by(p).run, null); }
  });

  await it('watcher: the pid files are read on every GET, not on the cached refresh', async () => {
    const a = repo();
    const f = fake(); overrideCodegraphRunner(f.run);
    assert.strictEqual((await row(a)).watching, false);
    writePid(a.dir, 'daemon.pid', process.pid, 5);
    assert.strictEqual((await row(a)).watching, true);
    assert.strictEqual(f.status(), 1);
  });

  await it('rebuild: a live rebuild.pid with no own run reads as a reindex run since its startedAt', async () => {
    const a = repo();
    writePid(a.dir, 'rebuild.pid', process.pid, 1000);
    overrideCodegraphRunner(fake().run);
    const r = await row(a);
    assert.strictEqual(r.rebuildLive, true);
    assert.deepStrictEqual(r.run, { kind: 'reindex', startedAtMs: 1000 });
  });

  await it('rebuild: no startedAt falls back to now', async () => {
    const a = repo();
    writePid(a.dir, 'rebuild.pid', process.pid);
    overrideCodegraphRunner(fake().run);
    assert.deepStrictEqual((await row(a)).run, { kind: 'reindex', startedAtMs: START });
  });

  await it('rebuild: a refresh that reads none while the rebuild is live keeps the earlier stats', async () => {
    const a = repo();
    let answer = FIXTURE;
    overrideCodegraphRunner(fake(async () => ({ code: 0, stdout: answer, stderr: '' })).run);
    const before = await row(a);
    assert.ok(before.state === 'ok');
    writePid(a.dir, 'rebuild.pid', process.pid, 1000);
    answer = JSON.stringify({ initialized: false });
    now += CODEGRAPH_TTL_MS + 1;
    await get();
    await codegraphRunsSettled();
    const during = await row(a);
    assert.ok(during.state === 'ok' && before.state === 'ok' && during.stats.fileCount === before.stats.fileCount, 'earlier stats survive a none read');
    assert.deepStrictEqual(during.run, { kind: 'reindex', startedAtMs: 1000 });
  });

  await it('rebuild: an error read while live keeps earlier stats, or is building when there are none; at rest it stays an error', async () => {
    const withStats = repo();
    let broken = false;
    overrideCodegraphRunner(fake(async () => (broken ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: FIXTURE, stderr: '' })).run);
    await get();
    broken = true;
    const fresh = repo(); const quiet = repo();
    writePid(withStats.dir, 'rebuild.pid', process.pid, 1);
    writePid(fresh.dir, 'rebuild.pid', process.pid, 2);
    now += CODEGRAPH_TTL_MS + 1;
    await get();
    await codegraphRunsSettled();
    const res = await get();
    const by = (p: Pinned) => res.repos.find(r => r.dirName === p.dirName)!;
    const kept = by(withStats);
    assert.ok(kept.state === 'ok' && kept.stats.fileCount === 416, 'earlier stats survive an error read');
    assert.strictEqual(by(fresh).state, 'building', 'no earlier stats: building');
    assert.strictEqual(by(quiet).state, 'error', 'no rebuild: the error stands');
  });

  await it('rebuild: live on one GET and dead on the next drops the entry inside the TTL', async () => {
    const a = repo();
    const f = fake(); overrideCodegraphRunner(f.run);
    writePid(a.dir, 'rebuild.pid', process.pid, 1);
    await get();
    assert.strictEqual(f.status(), 1);
    await get();
    assert.strictEqual(f.status(), 1, 'still live: the entry stands');
    writePid(a.dir, 'rebuild.pid', await deadPid(), 1);
    const r = await row(a);
    assert.strictEqual(f.status(), 2, 'a rebuild that ended means pre-rebuild stats are wrong');
    assert.strictEqual(r.rebuildLive, false);
    assert.strictEqual(r.run, null);
    await get();
    assert.strictEqual(f.status(), 2, 'and the new entry is fresh');
  });

  await it('cli-missing: a spawn ENOENT on a present folder says cli missing once for the page', async () => {
    repo();
    overrideCodegraphRunner(fake(async () => { throw Object.assign(new Error('spawn codegraph ENOENT'), { code: 'ENOENT' }); }).run);
    assert.strictEqual((await get()).cli, 'missing');
    overrideCodegraphRunner(fake().run);
    resetCodegraph();
    assert.strictEqual((await get()).cli, 'ok');
  });

  await it('states: no graph reads none and a dead pin reads missing, neither launching the CLI', async () => {
    const bare = repo('bare', false);
    const gone = repo('gone');
    fs.rmSync(gone.dir, { recursive: true });
    const f = fake(); overrideCodegraphRunner(f.run);
    const res = await get();
    assert.strictEqual(res.repos.find(r => r.dirName === bare.dirName)!.state, 'none');
    assert.strictEqual(res.repos.find(r => r.dirName === gone.dirName)!.state, 'missing');
    assert.strictEqual(f.calls.length, 0);
  });

  await it('start: a listed:false pin with a path is not-pinned and nothing launches', async () => {
    const gone = repo('gone');
    fs.rmSync(gone.dir, { recursive: true });
    const f = fake(); overrideCodegraphRunner(f.run);
    assert.strictEqual(await startCodegraphRun({}, gone.dirName, 'sync'), 'not-pinned');
    assert.strictEqual(f.calls.length, 0);
  });

  await it('start: refusals: unknown dirName, no graph, pending run, rebuild, and a lock with no watcher', async () => {
    const bare = repo('bare', false);
    const a = repo(); const locked = repo(); const watched = repo(); const rebuilding = repo();
    const f = parked(); overrideCodegraphRunner(f.run);
    assert.strictEqual(await startCodegraphRun({}, '-no-such-pin', 'sync'), 'not-pinned');
    assert.strictEqual(await startCodegraphRun({}, bare.dirName, 'sync'), 'not-indexed');

    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started');
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'busy', 'a second call while the first run is pending');
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'reindex'), 'busy', 'either kind');

    writePid(locked.dir, 'codegraph.lock', process.pid);
    assert.strictEqual(await startCodegraphRun({}, locked.dirName, 'sync'), 'busy');

    writePid(watched.dir, 'codegraph.lock', process.pid);
    writePid(watched.dir, 'daemon.pid', process.pid, 1);
    assert.strictEqual(await startCodegraphRun({}, watched.dirName, 'sync'), 'started', 'with a watcher the lock is the watcher\'s');

    writePid(rebuilding.dir, 'rebuild.pid', process.pid, 1);
    assert.strictEqual(await startCodegraphRun({}, rebuilding.dirName, 'sync'), 'busy');
    assert.strictEqual(f.runs().length, 2, 'only the two started runs launched');
    f.release(); await codegraphRunsSettled();
  });

  await it('start: two calls on one dirName at once launch once', async () => {
    const a = repo();
    const f = parked(); overrideCodegraphRunner(f.run);
    const answers = await Promise.all([startCodegraphRun({}, a.dirName, 'sync'), startCodegraphRun({}, a.dirName, 'sync')]);
    assert.deepStrictEqual([...answers].sort(), ['busy', 'started']);
    assert.strictEqual(f.runs().length, 1);
    f.release(); await codegraphRunsSettled();
  });

  await it('start: a repo pin and its subdirectory pin racing launch once', async () => {
    const top = repo('mono');
    const sub = pinned(path.join(top.dir, 'sub'), false);
    const f = parked(); overrideCodegraphRunner(f.run);
    const answers = await Promise.all([startCodegraphRun({}, top.dirName, 'sync'), startCodegraphRun({}, sub.dirName, 'reindex')]);
    assert.deepStrictEqual([...answers].sort(), ['busy', 'started']);
    assert.strictEqual(f.runs().length, 1);
    const rows = (await get()).repos;
    assert.ok(rows.every(r => r.run !== null && r.run.kind === rows[0].run!.kind), 'both rows show the one run');
    f.release(); await codegraphRunsSettled();
  });

  await it('start: launches with cwd = the graph root and argv exactly sync / index', async () => {
    const top = repo('mono');
    const sub = pinned(path.join(top.dir, 'deep', 'sub'), false);
    const f = parked(); overrideCodegraphRunner(f.run);
    assert.strictEqual(await startCodegraphRun({}, sub.dirName, 'sync'), 'started');
    assert.deepStrictEqual(f.runs(), [{ cwd: top.dir, args: ['sync'] }]);
    f.release(); await codegraphRunsSettled();
    assert.strictEqual(await startCodegraphRun({}, sub.dirName, 'reindex'), 'started');
    assert.deepStrictEqual(f.runs()[1], { cwd: top.dir, args: ['index'] });
    f.release(); await codegraphRunsSettled();
  });

  await it('start: no timeout on a run; the row shows the run while it lasts and the repo is free again after', async () => {
    const a = repo();
    const seen: (number | null)[] = [];
    const f = parked();
    overrideCodegraphRunner((cwd, args, t) => { if (args[0] !== 'status') seen.push(t); return f.run(cwd, args, t); });
    now = START + 7;
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started');
    assert.deepStrictEqual(seen, [null]);
    assert.deepStrictEqual((await row(a)).run, { kind: 'sync', startedAtMs: START + 7 });
    f.release(); await codegraphRunsSettled();
    assert.strictEqual((await row(a)).run, null);
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started');
    f.release(); await codegraphRunsSettled();
  });

  await it('run end: exit 0 records ok and drops the cache so the next GET reads fresh; no run ending means no fresh read', async () => {
    const a = repo();
    const f = fake(); overrideCodegraphRunner(f.run);
    await get();
    await get();
    assert.strictEqual(f.status(), 1, 'mirror: no run ended, the cache stands');
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started');
    await codegraphRunsSettled();
    now += 5;
    const r = await row(a);
    assert.strictEqual(f.status(), 2, 'the run ended inside the TTL and the next GET still read');
    assert.deepStrictEqual(r.lastRun, { kind: 'sync', ok: true, endedAtMs: START, message: 'exit 0' });
  });

  await it('run end: a lock-loss exit is ok with the watcher message when a watcher was live at launch, and a failure without one', async () => {
    const watched = repo(); const bare = repo();
    writePid(watched.dir, 'daemon.pid', process.pid, 1);
    const f = fake(async (_c, args) => (args[0] === 'status'
      ? { code: 0, stdout: FIXTURE, stderr: '' }
      : { code: 1, stdout: '', stderr: `starting\n${LOCK_LINE}\n` }));
    overrideCodegraphRunner(f.run);
    assert.ok(LOCK_LINE.includes(LOCK_LOSS_TEXT));
    assert.strictEqual(await startCodegraphRun({}, watched.dirName, 'sync'), 'started');
    assert.strictEqual(await startCodegraphRun({}, bare.dirName, 'sync'), 'started');
    await codegraphRunsSettled();
    const res = await get();
    const w = res.repos.find(r => r.dirName === watched.dirName)!.lastRun!;
    const b = res.repos.find(r => r.dirName === bare.dirName)!.lastRun!;
    assert.deepStrictEqual([w.ok, w.message], [true, WATCHER_SYNCING_TEXT]);
    assert.deepStrictEqual([b.ok, b.message], [false, LOCK_LINE]);
  });

  await it('run end: a non-lock failure is a failure even with a watcher; the message falls back to stdout, then the exit code', async () => {
    const a = repo(); const b = repo(); const c = repo();
    writePid(a.dir, 'daemon.pid', process.pid, 1);
    const f = fake(async (cwd, args) => {
      if (args[0] === 'status') return { code: 0, stdout: FIXTURE, stderr: '' };
      if (cwd === a.dir) return { code: 2, stdout: '', stderr: 'disk full\n\n' };
      if (cwd === b.dir) return { code: 3, stdout: 'out line\n', stderr: '' };
      return { code: 4, stdout: '', stderr: '' };
    });
    overrideCodegraphRunner(f.run);
    for (const p of [a, b, c]) assert.strictEqual(await startCodegraphRun({}, p.dirName, 'reindex'), 'started');
    await codegraphRunsSettled();
    const res = await get();
    const last = (p: Pinned) => res.repos.find(r => r.dirName === p.dirName)!.lastRun!;
    assert.deepStrictEqual([last(a).ok, last(a).message, last(a).kind], [false, 'disk full', 'reindex']);
    assert.deepStrictEqual([last(b).ok, last(b).message], [false, 'out line']);
    assert.deepStrictEqual([last(c).ok, last(c).message], [false, 'exit 4']);
  });

  await it('run end: a spawn rejection is a failed lastRun carrying its message', async () => {
    const a = repo();
    overrideCodegraphRunner(fake(async (_c, args) => {
      if (args[0] === 'status') return { code: 0, stdout: FIXTURE, stderr: '' };
      throw Object.assign(new Error('spawn codegraph ENOENT'), { code: 'ENOENT' });
    }).run);
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started');
    await codegraphRunsSettled();
    const r = await row(a);
    assert.deepStrictEqual([r.run, r.lastRun!.ok, r.lastRun!.message], [null, false, 'spawn codegraph ENOENT']);
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started', 'a rejected run frees the repo');
    await codegraphRunsSettled();
  });

  await it('run end: a successful run replaces an earlier failed one, and the failure is held until then', async () => {
    const a = repo();
    let code = 1;
    overrideCodegraphRunner(fake(async (_c, args) => (args[0] === 'status'
      ? { code: 0, stdout: FIXTURE, stderr: '' }
      : { code, stdout: '', stderr: code ? 'nope' : '' })).run);
    await startCodegraphRun({}, a.dirName, 'sync');
    await codegraphRunsSettled();
    now += 60_000;
    assert.strictEqual((await row(a)).lastRun!.ok, false, 'a failed run stays visible');
    code = 0;
    await startCodegraphRun({}, a.dirName, 'reindex');
    await codegraphRunsSettled();
    const r = (await row(a)).lastRun!;
    assert.deepStrictEqual([r.ok, r.kind], [true, 'reindex']);
  });

  await it('run end: a read that was in flight when the run ended does not put pre-run stats back', async () => {
    const a = repo();
    let release: () => void = () => {};
    let files = 416;
    const f = fake(async (_c, args) => {
      if (args[0] !== 'status') return { code: 0, stdout: '', stderr: '' };
      const out = statusWith(files);
      if (files === 416 && f.status() === 2) await new Promise<void>(r => { release = r; });
      return { code: 0, stdout: out, stderr: '' };
    });
    overrideCodegraphRunner(f.run);
    await get();
    now += CODEGRAPH_TTL_MS + 1;
    await get(); // background refresh #2 parks holding the old 416
    assert.strictEqual(await startCodegraphRun({}, a.dirName, 'sync'), 'started');
    await sleep(10);
    files = 999;
    release();
    await codegraphRunsSettled();
    const r = await row(a); // run ended: entry dropped, this is a cold read of the post-run state
    assert.ok(r.state === 'ok' && r.stats.fileCount === 999);
  });

  console.log(`\ncodegraph-store: ${ok_}/${total} passed`);
  return total - ok_;
}
