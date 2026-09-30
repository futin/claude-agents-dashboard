/**
 * `GET/POST /api/pins` (#161), driven through the real route table: the token
 * gate, the body shape, the membership rule a pin must pass (a pinned dir
 * becomes spawnable and its config servable, so this is the gate), the dead-pin
 * row, and the knock-on effect on `GET /api/management`.
 *
 * The harness `$HOME` is a tmpdir, and the older-projects list never offers a
 * cwd under one, so every case here lifts that filter with `overrideClaudeRoots`.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { getPinnedProjects, resetSettings } from '../server/lib/settings.js';
import type { PinsResponse, ProjectRef } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const DAY = 24 * 3600_000;

/** A project cwd (default `$HOME/projs/<name>`), with one transcript `ageDays` old. Returns its dirName. */
function plantProject(h: Harness, name: string, ageDays: number, cwd = path.join(h.home, 'projs', name)): { dirName: string; cwd: string } {
  fs.mkdirSync(cwd, { recursive: true });
  const dirName = encodeProjectDir(cwd);
  const dir = path.join(h.home, '.claude', 'projects', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-1.jsonl`);
  fs.writeFileSync(file, JSON.stringify(userRecord(`${name}-u1`, 'hi', cwd)) + '\n');
  const at = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(file, at, at);
  return { dirName, cwd };
}

function post(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  return h.req('/api/pins', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
}

/** Each case starts with no pins and the Claude-root filter off, and leaves both that way. */
async function withPins(env: string, fn: (h: Harness) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withServer(env, async h => {
      resetSettings();
      try { await fn(h); } finally { resetSettings(); }
    });
  } finally {
    overrideClaudeRoots(null);
  }
}

export async function run(): Promise<number> {
  console.log('\n=== pins endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('POST /api/pins with ANSWER_TOKEN set and no bearer is 403 and writes nothing', async () => {
    await withPins(ENV + 'ANSWER_TOKEN=s3cret\n', async h => {
      const { dirName } = plantProject(h, 'old', 5);
      const reply = await post(h, { dirName, pinned: true });
      assert.equal(reply.status, 403);
      assert.equal(reply.json?.error, 'bad token');
      assert.deepStrictEqual(getPinnedProjects(), []);
      assert.ok(!fs.existsSync(path.join(h.home, '.dashboard-settings.json')), 'nothing written to disk');
    });
  }));

  check(await testAsync('POST /api/pins with a malformed body is 400', async () => {
    await withPins(ENV, async h => {
      for (const body of [{}, { dirName: 7, pinned: true }, { dirName: '-a' }]) {
        const reply = await post(h, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
      }
      assert.deepStrictEqual(getPinnedProjects(), []);
    });
  }));

  check(await testAsync('pinning a dirName that is neither recent nor older is 404 and stores nothing', async () => {
    await withPins(ENV, async h => {
      plantProject(h, 'old', 5);
      for (const dirName of ['-nope', '../x']) {
        const reply = await post(h, { dirName, pinned: true });
        assert.equal(reply.status, 404, dirName);
        assert.equal(reply.json?.error, 'no such project');
      }
      assert.deepStrictEqual(getPinnedProjects(), []);
    });
  }));

  check(await testAsync('pinning a 5-day-old dir: 200, moves from older to pinned, and GET /api/management lists it pinned', async () => {
    await withPins(ENV, async h => {
      const { dirName, cwd } = plantProject(h, 'old', 5);
      const before = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(before.older.map(r => r.dirName), [dirName]);
      assert.deepStrictEqual(before.pinned, []);

      const reply = await post(h, { dirName, pinned: true });
      assert.equal(reply.status, 200);
      const after = reply.json as unknown as PinsResponse;
      assert.deepStrictEqual(after.pinned.map(r => [r.dirName, r.path, r.listed]), [[dirName, cwd, true]]);
      assert.deepStrictEqual(after.older, []);

      const mgmt = (await h.req('/api/management')).json as { projects: ProjectRef[] };
      const row = mgmt.projects.find(p => p.dirName === dirName);
      assert.ok(row, 'the pinned project is listed');
      assert.strictEqual(row!.pinned, true);
    });
  }));

  check(await testAsync('a 1-day-old dir is offered under recent, not older, and pinning it moves it to pinned', async () => {
    await withPins(ENV, async h => {
      const { dirName, cwd } = plantProject(h, 'fresh', 1 / 24);
      const before = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(before.recent.map(r => r.dirName), [dirName]);
      assert.deepStrictEqual(before.older, []);

      const reply = await post(h, { dirName, pinned: true });
      assert.equal(reply.status, 200);
      const after = reply.json as unknown as PinsResponse;
      assert.deepStrictEqual(after.pinned.map(r => [r.dirName, r.path, r.listed]), [[dirName, cwd, true]]);
      assert.deepStrictEqual(after.recent, [], 'a pinned project is not offered again');
    });
  }));

  check(await testAsync('a recent dir under a Claude root is not offered, and a pin already made there stays listed', async () => {
    await withPins(ENV, async h => {
      overrideClaudeRoots([path.join(h.home, '.claude')]);
      const mine = plantProject(h, 'mine', 1 / 24);
      const own = plantProject(h, 'refresh', 1 / 24, path.join(h.home, '.claude', 'dashboard-refresh'));
      const before = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(before.recent.map(r => r.dirName), [mine.dirName]);

      // The gate still knows it — it is listed on the rail — so a pin made before the filter survives it.
      assert.equal((await post(h, { dirName: own.dirName, pinned: true })).status, 200);
      const after = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(after.pinned.map(r => [r.dirName, r.listed]), [[own.dirName, true]]);
      assert.deepStrictEqual(after.recent.map(r => r.dirName), [mine.dirName]);
    });
  }));

  check(await testAsync('a pin whose cwd was deleted reads listed: false, and unpinning it is 200', async () => {
    await withPins(ENV, async h => {
      const { dirName, cwd } = plantProject(h, 'old', 5);
      assert.equal((await post(h, { dirName, pinned: true })).status, 200);
      fs.rmSync(cwd, { recursive: true, force: true });

      const dead = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(dead.pinned.map(r => [r.dirName, r.path, r.listed]), [[dirName, cwd, false]]);

      const reply = await post(h, { dirName, pinned: false });
      assert.equal(reply.status, 200);
      assert.deepStrictEqual((reply.json as unknown as PinsResponse).pinned, []);
      assert.deepStrictEqual(getPinnedProjects(), []);
    });
  }));

  check(await testAsync('unpinning a dir that was never pinned is 200 with an unchanged payload', async () => {
    await withPins(ENV, async h => {
      plantProject(h, 'old', 5);
      const before = (await h.req('/api/pins')).json;
      const reply = await post(h, { dirName: '-never-pinned', pinned: false });
      assert.equal(reply.status, 200);
      assert.deepStrictEqual(reply.json, before);
    });
  }));

  console.log(`\npins endpoints: ${ok}/${total} passed`);
  return total - ok;
}
