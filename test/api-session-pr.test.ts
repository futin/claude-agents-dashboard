/**
 * `GET /api/sessions/:id/pr`, driven through the real route table: the `ID_RE` check, the empty answers, the merge of the detected PR with `gh`'s live
 * state, and the 500 on an unreadable transcript. Going over a socket also proves the route sits before the session-detail regex, which would otherwise
 * swallow `:id/pr`. `gh` itself is a stub here; `pr-status.test.ts` covers the fold.
 */

import assert from 'node:assert';
import fs from 'node:fs';

import { testAsync, withServer } from './api-harness.js';
import type { FetchRunner } from '../server/lib/git-fetch.js';
import type { SessionPrInfo } from '../shared/types.js';
import { resetPrDetectCache } from '../server/lib/pr-detect.js';
import { overrideGhRunner, resetPrStatusCache } from '../server/lib/pr-status.js';

const ID = '22222222-2222-4222-8222-222222222222';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const URL7 = 'https://github.com/o/r/pull/7';

/** An assistant `gh pr create` call carrying `--title "Arg title"`, and its result with Claude Code's gitOperation create record. */
function createRecords(cwd: string): unknown[] {
  return [
    { type: 'assistant', cwd, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_pr_1', name: 'Bash', input: { command: 'gh pr create --title "Arg title" --body x' } },
    ] } },
    { type: 'user', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pr_1', content: URL7, is_error: false }] },
      toolUseResult: { stdout: URL7, stderr: '', gitOperation: { pr: { number: 7, url: URL7, action: 'created' } } } },
  ];
}

const merged: FetchRunner = async () => ({
  code: 0, stderr: '', timedOut: false,
  stdout: JSON.stringify({
    number: 7, title: 'Real title', url: URL7, state: 'MERGED', isDraft: false, headRefName: 'fix/a', baseRefName: 'main', statusCheckRollup: [],
    reviewDecision: 'APPROVED', mergeable: 'UNKNOWN', mergedAt: '2026-10-24T10:00:00Z', closedAt: '2026-10-24T10:00:00Z',
  }),
});

const missingGh: FetchRunner = () => Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));

/** Every case starts from cold caches: `withServer` resets neither module, and A4 caches `…/pull/7` as merged for good. */
function fresh(run: FetchRunner | null): void {
  resetPrStatusCache();
  resetPrDetectCache();
  overrideGhRunner(run);
}

export async function run(): Promise<number> {
  console.log('\n=== GET /api/sessions/:id/pr ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('A1. a malformed id is 400 with error and no PR', async () => {
    fresh(null);
    await withServer(ENV, async h => {
      const reply = await h.req('/api/sessions/bad%20id!/pr');
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, true);
      assert.strictEqual(reply.json?.pr, null);
    });
  }));

  check(await testAsync('A2. a well-formed id with no transcript is 200 with no PR', async () => {
    fresh(null);
    await withServer(ENV, async h => {
      const reply = await h.req(`/api/sessions/${ID}/pr`);
      assert.equal(reply.status, 200);
      assert.strictEqual(reply.json?.pr, null);
      assert.equal(reply.json?.error, undefined);
    });
  }));

  check(await testAsync('A3. a transcript with no PR is 200 with no PR', async () => {
    fresh(null);
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req(`/api/sessions/${ID}/pr`);
      assert.equal(reply.status, 200);
      assert.strictEqual(reply.json?.pr, null);
    });
  }));

  check(await testAsync('A4. a created PR merges with gh: live title wins, repo from the URL', async () => {
    fresh(merged);
    await withServer(ENV, async h => {
      h.plant(ID, createRecords(h.home));
      const reply = await h.req(`/api/sessions/${ID}/pr`);
      assert.equal(reply.status, 200);
      const pr = reply.json?.pr as SessionPrInfo | null | undefined;
      assert.equal(pr?.url, URL7);
      assert.equal(pr?.number, 7);
      assert.equal(pr?.repo, 'o/r');
      assert.equal(pr?.title, 'Real title');
      assert.equal(pr?.live?.state, 'merged');
      assert.strictEqual(pr?.unavailable, null);
    });
  }));

  check(await testAsync('A5. gh missing keeps the detected PR with its command title and the reason', async () => {
    fresh(missingGh);
    await withServer(ENV, async h => {
      h.plant(ID, createRecords(h.home));
      const reply = await h.req(`/api/sessions/${ID}/pr`);
      assert.equal(reply.status, 200);
      const pr = reply.json?.pr as SessionPrInfo | null | undefined;
      assert.strictEqual(pr?.live, null);
      assert.equal(pr?.unavailable, 'gh not installed');
      assert.equal(pr?.title, 'Arg title');
    });
  }));

  check(await testAsync('A6. an unreadable transcript is 500 with error', async () => {
    if (process.getuid?.() === 0) return; // root reads mode 000
    fresh(null);
    await withServer(ENV, async h => {
      const file = h.plant(ID, createRecords(h.home));
      fs.chmodSync(file, 0);
      try {
        const reply = await h.req(`/api/sessions/${ID}/pr`);
        assert.equal(reply.status, 500);
        assert.equal(reply.json?.error, true);
        assert.strictEqual(reply.json?.pr, null);
      } finally {
        fs.chmodSync(file, 0o644);
      }
    });
  }));

  fresh(null);
  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}

if (import.meta.url === `file://${process.argv[1]}`) run().then((f) => process.exit(f > 0 ? 1 : 0));
