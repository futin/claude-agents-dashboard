import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FetchRunner } from '../server/lib/git-fetch.js';
import {
  foldPrView, overrideGhRunner, overridePrClock, readPrStatus, resetPrStatusCache,
} from '../server/lib/pr-status.js';

async function test(name: string, fn: () => Promise<void> | void): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const URL7 = 'https://github.com/o/r/pull/7';
const JSON_FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable,mergedAt,closedAt';

type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
interface Call { cwd: string; args: string[]; env: Record<string, string> }

/** A spy runner answering every launch with `answer()`; `calls` records each launch. */
function spy(answer: () => Promise<RunResult> | RunResult): { run: FetchRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: FetchRunner = async (cwd, args, env) => { calls.push({ cwd, args, env }); return answer(); };
  return { run, calls };
}

let clock = 1_000_000;

/** Fresh cache, fixed clock, the given runner. */
function setup(run: FetchRunner): void {
  resetPrStatusCache();
  clock = 1_000_000;
  overridePrClock(() => clock);
  overrideGhRunner(run);
}

/** A `gh pr view --json` body: an open, mergeable PR with no checks unless `over` says otherwise. */
function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7, title: 'Fix: a', url: URL7, state: 'OPEN', isDraft: false, headRefName: 'fix/a', baseRefName: 'main',
    statusCheckRollup: [], reviewDecision: '', mergeable: 'MERGEABLE', mergedAt: null, closedAt: null, ...over,
  };
}

const ok = (body: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false });

const run_ = (status: string, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion, name: 'x' });
const ctx = (state: string) => ({ __typename: 'StatusContext', state, context: 'x' });

export async function run(): Promise<number> {
  console.log('\n=== pr-status ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean) => { if (ok) p++; else f++; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-pr-status-'));

  tally(await test('S1. argv and env are exactly the pinned ones', async () => {
    const s = spy(() => ok(view()));
    setup(s.run);
    await readPrStatus(URL7, dir);
    assert.strictEqual(s.calls.length, 1);
    assert.deepStrictEqual(s.calls[0].args, ['pr', 'view', URL7, '--json', JSON_FIELDS]);
    assert.strictEqual(s.calls[0].env.GH_NO_UPDATE_NOTIFIER, '1');
    assert.strictEqual(s.calls[0].env.GH_PROMPT_DISABLED, '1');
  }));

  tally(await test('S2. a rollup of eleven counts 3 passed, 2 failed, 4 running of 9', () => {
    const rollup = [
      run_('COMPLETED', 'SUCCESS'), run_('COMPLETED', 'SUCCESS'), run_('IN_PROGRESS'), run_('QUEUED'), run_('QUEUED'),
      run_('COMPLETED', 'SKIPPED'), run_('COMPLETED', 'FAILURE'), ctx('SUCCESS'), ctx('PENDING'), ctx('ERROR'), { __typename: 'Other', state: 'SUCCESS' },
    ];
    assert.deepStrictEqual(foldPrView(view({ statusCheckRollup: rollup }))?.checks, { passed: 3, failed: 2, running: 4, total: 9 });
  }));

  tally(await test('S3. no countable checks is null: all skipped, empty, missing', () => {
    assert.strictEqual(foldPrView(view({ statusCheckRollup: [run_('COMPLETED', 'SKIPPED'), run_('COMPLETED', 'NEUTRAL')] }))?.checks, null);
    assert.strictEqual(foldPrView(view({ statusCheckRollup: [] }))?.checks, null);
    const missing = view();
    delete missing.statusCheckRollup;
    assert.strictEqual(foldPrView(missing)?.checks, null);
  }));

  tally(await test('S4. state precedence: merged, closed, then draft, then open', () => {
    assert.strictEqual(foldPrView(view({ state: 'MERGED', isDraft: true }))?.state, 'merged');
    assert.strictEqual(foldPrView(view({ state: 'CLOSED', isDraft: true }))?.state, 'closed');
    assert.strictEqual(foldPrView(view({ state: 'OPEN', isDraft: true }))?.state, 'draft');
    assert.strictEqual(foldPrView(view({ state: 'OPEN' }))?.state, 'open');
  }));

  tally(await test('S5. reviewDecision maps to approved / changes / required / none', () => {
    assert.strictEqual(foldPrView(view({ reviewDecision: 'APPROVED' }))?.review, 'approved');
    assert.strictEqual(foldPrView(view({ reviewDecision: 'CHANGES_REQUESTED' }))?.review, 'changes');
    assert.strictEqual(foldPrView(view({ reviewDecision: 'REVIEW_REQUIRED' }))?.review, 'required');
    assert.strictEqual(foldPrView(view({ reviewDecision: '' }))?.review, 'none');
    const missing = view();
    delete missing.reviewDecision;
    assert.strictEqual(foldPrView(missing)?.review, 'none');
  }));

  tally(await test('S6. mergeable maps to clean / conflicts / unknown', () => {
    assert.strictEqual(foldPrView(view({ mergeable: 'MERGEABLE' }))?.merge, 'clean');
    assert.strictEqual(foldPrView(view({ mergeable: 'CONFLICTING' }))?.merge, 'conflicts');
    assert.strictEqual(foldPrView(view({ mergeable: 'UNKNOWN' }))?.merge, 'unknown');
  }));

  tally(await test('S7. endedAt: merged takes mergedAt, closed takes closedAt, open is null; title/head/base carried', () => {
    const times = { mergedAt: '2026-10-24T10:00:00Z', closedAt: '2026-10-24T10:00:01Z' };
    assert.strictEqual(foldPrView(view({ state: 'MERGED', ...times }))?.endedAt, '2026-10-24T10:00:00Z');
    assert.strictEqual(foldPrView(view({ state: 'CLOSED', ...times }))?.endedAt, '2026-10-24T10:00:01Z');
    const open = foldPrView(view(times));
    assert.strictEqual(open?.endedAt, null);
    assert.deepStrictEqual([open?.title, open?.head, open?.base], ['Fix: a', 'fix/a', 'main']);
    assert.strictEqual(foldPrView({ state: 'OPEN', headRefName: 'x' }), null);
  }));

  tally(await test('S8. each failure gets its reason', async () => {
    const cases: Array<[() => Promise<RunResult> | RunResult, string]> = [
      [() => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })), 'gh not installed'],
      [() => ({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login', timedOut: false }), 'gh not signed in'],
      [() => ({ code: -1, stdout: '', stderr: '', timedOut: true }), 'timed out'],
      [() => ({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest', timedOut: false }), 'gh failed'],
      [() => ({ code: 0, stdout: 'nope', stderr: '', timedOut: false }), 'gh failed'],
    ];
    for (const [answer, reason] of cases) {
      setup(spy(answer).run);
      assert.deepStrictEqual(await readPrStatus(URL7, dir), { live: null, unavailable: reason });
    }
  }));

  tally(await test('S9. a URL that is not a github.com PR never launches', async () => {
    const s = spy(() => ok(view()));
    setup(s.run);
    for (const url of ['https://ghe.example.com/o/r/pull/4', '--web']) {
      assert.deepStrictEqual(await readPrStatus(url, dir), { live: null, unavailable: 'not a GitHub PR' });
    }
    assert.strictEqual(s.calls.length, 0);
  }));

  tally(await test('S10. cwd: an existing dir is used; a missing path or null falls back to home', async () => {
    const s = spy(() => ok(view()));
    setup(s.run);
    await readPrStatus(URL7, dir);
    resetPrStatusCache();
    await readPrStatus(URL7, path.join(dir, 'gone'));
    resetPrStatusCache();
    await readPrStatus(URL7, null);
    assert.deepStrictEqual(s.calls.map((c) => c.cwd), [dir, os.homedir(), os.homedir()]);
  }));

  tally(await test('S11. a regular file as cwd falls back to home', async () => {
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const s = spy(() => ok(view()));
    setup(s.run);
    await readPrStatus(URL7, file);
    assert.strictEqual(s.calls[0].cwd, os.homedir());
  }));

  tally(await test('S12. concurrent calls share one launch', async () => {
    let release!: (r: RunResult) => void;
    const s = spy(() => new Promise<RunResult>((res) => { release = res; }));
    setup(s.run);
    const a = readPrStatus(URL7, dir);
    const b = readPrStatus(URL7, dir);
    await Promise.resolve();
    release(ok(view()));
    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(s.calls.length, 1);
    assert.deepStrictEqual(ra, rb);
    assert.strictEqual(ra.live?.state, 'open');
  }));

  tally(await test('S13. open with a running check re-reads after 20s; settled after 60s', async () => {
    const busy = spy(() => ok(view({ statusCheckRollup: [run_('IN_PROGRESS')] })));
    setup(busy.run);
    await readPrStatus(URL7, dir);
    clock += 19_000; await readPrStatus(URL7, dir);
    assert.strictEqual(busy.calls.length, 1);
    clock += 2_000; await readPrStatus(URL7, dir);
    assert.strictEqual(busy.calls.length, 2);

    const settled = spy(() => ok(view({ statusCheckRollup: [run_('COMPLETED', 'SUCCESS')] })));
    setup(settled.run);
    await readPrStatus(URL7, dir);
    clock += 59_000; await readPrStatus(URL7, dir);
    assert.strictEqual(settled.calls.length, 1);
    clock += 2_000; await readPrStatus(URL7, dir);
    assert.strictEqual(settled.calls.length, 2);
  }));

  tally(await test('S14. a merged PR is never re-read', async () => {
    const s = spy(() => ok(view({ state: 'MERGED', mergedAt: '2026-10-24T10:00:00Z' })));
    setup(s.run);
    await readPrStatus(URL7, dir);
    clock += 86_400_000;
    assert.strictEqual((await readPrStatus(URL7, dir)).live?.state, 'merged');
    assert.strictEqual(s.calls.length, 1);
  }));

  tally(await test('S15. a failure is kept for 20s, then retried', async () => {
    const s = spy(() => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }));
    setup(s.run);
    await readPrStatus(URL7, dir);
    clock += 19_000;
    assert.deepStrictEqual(await readPrStatus(URL7, dir), { live: null, unavailable: 'gh failed' });
    assert.strictEqual(s.calls.length, 1);
    clock += 2_000; await readPrStatus(URL7, dir);
    assert.strictEqual(s.calls.length, 2);
  }));

  tally(await test('S16. merge unknown with no running checks uses the 20s window', async () => {
    const s = spy(() => ok(view({ mergeable: 'UNKNOWN' })));
    setup(s.run);
    await readPrStatus(URL7, dir);
    clock += 21_000; await readPrStatus(URL7, dir);
    assert.strictEqual(s.calls.length, 2);
  }));

  overrideGhRunner(null);
  overridePrClock(null);
  resetPrStatusCache();
  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) run().then((f) => process.exit(f > 0 ? 1 : 0));
