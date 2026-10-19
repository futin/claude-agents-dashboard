/**
 * `GET /api/codegraph` and `POST /api/codegraph/run` through the real route table (codegraph-view spec §API).
 *
 * The CLI is a fake runner behind `overrideCodegraphRunner`, wrapped so every call is recorded: a refused request is proved by the runner seeing no `sync` or
 * `index` rather than by the response alone. Pins come from `setPinned` over transcripts whose `cwd` is a tmpdir folder, the way `api-git-fetch.test.ts` does.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { overrideCodegraphRunner } from '../server/lib/codegraph.js';
import type { CodegraphRunner } from '../server/lib/codegraph.js';
import { codegraphRunsSettled, resetCodegraph } from '../server/lib/codegraph-store.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';
import type { CodegraphResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nANSWER_TOKEN=secret\n';
const AUTH = { Authorization: 'Bearer secret' };
/** A LAN peer as Vite would deliver one: loopback writes need no token. */
const LAN = { 'X-Forwarded-For': '192.168.1.5' };
const FIXTURE = fs.readFileSync(new URL('./fixtures/codegraph-status-1.6.2.json', import.meta.url), 'utf8');

interface Call { cwd: string; args: string[] }
interface Fake { calls: Call[]; runs(): Call[]; release(): void }

/** Answers `status` with the fixture; a run parks until `release`, so a second POST can arrive while the first is still going. */
function parkedRunner(): Fake & { run: CodegraphRunner } {
  const calls: Call[] = [];
  const resolvers: (() => void)[] = [];
  const run: CodegraphRunner = (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === 'status') return Promise.resolve({ code: 0, stdout: FIXTURE, stderr: '' });
    return new Promise(resolve => { resolvers.push(() => resolve({ code: 0, stdout: '', stderr: '' })); });
  };
  return { run, calls, runs: () => calls.filter(c => c.args[0] !== 'status'), release: () => { for (const r of resolvers.splice(0)) r(); } };
}

/** A pinned folder: a transcript with this `cwd`, then the pin. `indexed` gives the folder an (empty) `codegraph.db`. */
function pinFolder(h: Harness, rel: string, indexed: boolean): { dir: string; dirName: string } {
  const dir = path.join(h.home, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (indexed) {
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  }
  const dirName = encodeProjectDir(dir);
  const proj = path.join(h.home, '.claude', 'projects', dirName);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.jsonl'), JSON.stringify(userRecord('u1', 'hi', dir)) + '\n');
  setPinned(dirName, true);
  return { dir, dirName };
}

/** Each case starts with no pins and a cold codegraph store, and leaves the modules that way. */
async function withCodegraphApi(fn: (h: Harness, fake: Fake & { run: CodegraphRunner }) => Promise<void>, env = ENV): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withServer(env, async h => {
      resetSettings();
      resetCodegraph();
      const fake = parkedRunner();
      overrideCodegraphRunner(fake.run);
      try {
        await fn(h, fake);
      } finally {
        fake.release();
        await codegraphRunsSettled();
        overrideCodegraphRunner(null);
        resetCodegraph();
        resetSettings();
      }
    });
  } finally {
    overrideClaudeRoots(null);
  }
}

const post = (h: Harness, body: unknown, headers: Record<string, string> = {}) =>
  h.req('/api/codegraph/run', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

export async function run(): Promise<number> {
  console.log('\n=== codegraph endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('GET /api/codegraph lists the repos in pin order with cli ok and the fixture stats', async () => {
    await withCodegraphApi(async h => {
      const a = pinFolder(h, 'repo-a', true);
      const b = pinFolder(h, 'repo-b', false);
      const reply = await h.req('/api/codegraph');
      assert.equal(reply.status, 200, reply.raw);
      const body = reply.json as unknown as CodegraphResponse;
      assert.equal(body.cli, 'ok');
      assert.equal(typeof body.generatedAt, 'number');
      assert.deepStrictEqual(body.repos.map(r => r.dirName).sort(), [a.dirName, b.dirName].sort());
      const first = body.repos.find(r => r.dirName === a.dirName)!;
      assert.equal(first.state, 'ok');
      assert.ok(first.state === 'ok' && first.stats.fileCount > 0, 'stats come from the fixture');
      assert.equal(body.repos.find(r => r.dirName === b.dirName)!.state, 'none');
    });
  }));

  check(await testAsync('POST /api/codegraph/run refuses in order: 405, 403 bad token, 400, 403 not pinned, 404, 400, then 200, 409', async () => {
    await withCodegraphApi(async (h, fake) => {
      const indexed = pinFolder(h, 'repo-a', true);
      const bare = pinFolder(h, 'repo-b', false);

      const wrongMethod = await h.req('/api/codegraph/run');
      assert.equal(wrongMethod.status, 405, wrongMethod.raw);
      assert.equal(wrongMethod.headers['allow'], 'POST');

      const noToken = await post(h, { dirName: indexed.dirName, kind: 'sync' }, LAN);
      assert.equal(noToken.status, 403, noToken.raw);
      assert.deepStrictEqual(noToken.json, { error: 'bad token' });

      const emptyBody = await post(h, {}, { ...LAN, ...AUTH });
      assert.equal(emptyBody.status, 400, emptyBody.raw);

      const stranger = await post(h, { dirName: 'nope', kind: 'sync' }, { ...LAN, ...AUTH });
      assert.equal(stranger.status, 403, stranger.raw);
      assert.deepStrictEqual(stranger.json, { error: 'not a pinned project' });

      const unindexed = await post(h, { dirName: bare.dirName, kind: 'sync' }, { ...LAN, ...AUTH });
      assert.equal(unindexed.status, 404, unindexed.raw);
      assert.deepStrictEqual(unindexed.json, { error: 'not indexed' });

      const badKind = await post(h, { dirName: indexed.dirName, kind: 'rebuild' }, { ...LAN, ...AUTH });
      assert.equal(badKind.status, 400, badKind.raw);
      // Shape before the store: an unpinned dirName with a bad kind is still a 400, not the 403 the store would give.
      assert.equal((await post(h, { dirName: 'nope', kind: 'rebuild' }, { ...LAN, ...AUTH })).status, 400);
      assert.equal(fake.runs().length, 0, 'no refused request may reach the CLI');

      const started = await post(h, { dirName: indexed.dirName, kind: 'sync' }, { ...LAN, ...AUTH });
      assert.equal(started.status, 200, started.raw);
      assert.deepStrictEqual(started.json, { ok: true });

      const again = await post(h, { dirName: indexed.dirName, kind: 'sync' }, { ...LAN, ...AUTH });
      assert.equal(again.status, 409, again.raw);
      assert.deepStrictEqual(again.json, { error: 'already running' });
      assert.deepStrictEqual(fake.runs().map(c => c.args), [['sync']], 'exactly one sync reached the CLI');
    });
  }));

  check(await testAsync('the write gate runs before the body is read: a LAN peer with a malformed body is 403, not 400, and nothing launches', async () => {
    await withCodegraphApi(async (h, fake) => {
      pinFolder(h, 'repo-a', true);
      const noToken = await post(h, 'not json', LAN);
      assert.equal(noToken.status, 403, noToken.raw);
      assert.deepStrictEqual(noToken.json, { error: 'bad token' });
      const wrong = await post(h, '{}', { ...LAN, Authorization: 'Bearer nope' });
      assert.equal(wrong.status, 403, wrong.raw);
      assert.equal(fake.runs().length, 0);
      // The same peer with the token gets as far as the body check.
      assert.equal((await post(h, 'not json', { ...LAN, ...AUTH })).status, 400);
    });
  }));

  check(await testAsync('with no ANSWER_TOKEN a LAN peer is read-only (403) even with a malformed body, and nothing launches', async () => {
    await withCodegraphApi(async (h, fake) => {
      pinFolder(h, 'repo-a', true);
      const refused = await post(h, 'not json', LAN);
      assert.equal(refused.status, 403, refused.raw);
      assert.deepStrictEqual(refused.json, { error: 'read-only from this network' });
      assert.equal(fake.runs().length, 0);
    }, 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n');
  }));

  check(await testAsync('a malformed body and a non-string dirName are 400 and launch nothing', async () => {
    await withCodegraphApi(async (h, fake) => {
      const indexed = pinFolder(h, 'repo-a', true);
      for (const body of ['not json', 'null', '[]', JSON.stringify({ dirName: '', kind: 'sync' }), JSON.stringify({ dirName: 7, kind: 'sync' }),
        JSON.stringify({ dirName: indexed.dirName })]) {
        const reply = await post(h, body);
        assert.equal(reply.status, 400, `${body}: ${reply.raw}`);
      }
      assert.equal(fake.runs().length, 0);
    });
  }));

  check(await testAsync('two identical POSTs sent together: one 200, one 409, and one sync', async () => {
    await withCodegraphApi(async (h, fake) => {
      const indexed = pinFolder(h, 'repo-a', true);
      const replies = await Promise.all([1, 2].map(() => post(h, { dirName: indexed.dirName, kind: 'sync' })));
      assert.deepStrictEqual(replies.map(r => r.status).sort(), [200, 409], replies.map(r => r.raw).join(' | '));
      assert.deepStrictEqual(fake.runs().map(c => c.args), [['sync']]);
    });
  }));

  check(await testAsync('a reindex answers 200 and runs `index`', async () => {
    await withCodegraphApi(async (h, fake) => {
      const indexed = pinFolder(h, 'repo-a', true);
      const reply = await post(h, { dirName: indexed.dirName, kind: 'reindex' });
      assert.equal(reply.status, 200, reply.raw);
      assert.deepStrictEqual(fake.runs().map(c => c.args), [['index']]);
    });
  }));

  check(await testAsync('a pin on a subdirectory runs the CLI from the graph root', async () => {
    await withCodegraphApi(async (h, fake) => {
      const repo = pinFolder(h, 'repo-a', true);
      const sub = pinFolder(h, 'repo-a/packages/web', false);
      const reply = await post(h, { dirName: sub.dirName, kind: 'sync' });
      assert.equal(reply.status, 200, reply.raw);
      assert.deepStrictEqual(fake.runs().map(c => [c.cwd, c.args]), [[repo.dir, ['sync']]]);
    });
  }));

  console.log(`\ncodegraph endpoints: ${ok}/${total} passed`);
  return total - ok;
}
