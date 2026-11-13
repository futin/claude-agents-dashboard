/**
 * `GET/POST /api/pins` (#161), driven through the real route table: the token
 * gate, the body shape, the membership rule a pin must pass (a pinned dir
 * becomes spawnable and its config servable, so this is the gate), the dead-pin
 * row, the knock-on effect on `GET /api/configs`, `POST /api/pins/order`'s
 * permutation rule, and what each route answers when a listing throws (#361).
 *
 * The harness `$HOME` is a tmpdir, and the older-projects list never offers a
 * cwd under one, so every case here lifts that filter with `overrideClaudeRoots`.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from '../api-harness.js';
import type { Harness } from '../api-harness.js';
import { overridePinsPayload } from '../../server/api.js';
import { encodeProjectDir } from '../../server/lib/management.js';
import { overrideClaudeRoots } from '../../server/lib/paths.js';
import { getPinnedProjects, resetSettings, setPinned } from '../../server/lib/settings.js';
import type { PinsResponse, ProjectRef } from '../../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const DAY = 24 * 3600_000;
const ANSWER_MS = 2000;

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

function postOrder(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  return h.req('/api/pins/order', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
}

function post(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  return h.req('/api/pins', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
}

/** The harness request has no timeout, so a handler that never answers would hang the whole suite: this turns that into one failed case. */
function answered<T>(reply: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no response within ${ANSWER_MS}ms`)), ANSWER_MS);
  });
  return Promise.race([reply, hung]).finally(() => clearTimeout(timer));
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
      const reply = await post(h, { dirName, pinned: true }, { 'X-Forwarded-For': '192.168.1.5' });
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

  check(await testAsync('pinning a 5-day-old dir: 200, moves from older to pinned, and GET /api/configs lists it pinned', async () => {
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

      const mgmt = (await h.req('/api/configs')).json as { projects: ProjectRef[] };
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

  check(await testAsync('a recent dir under a Claude root is neither offered nor pinnable, and a pin already stored there reads unlisted', async () => {
    await withPins(ENV, async h => {
      overrideClaudeRoots([path.join(h.home, '.claude')]);
      const mine = plantProject(h, 'mine', 1 / 24);
      const own = plantProject(h, 'refresh', 1 / 24, path.join(h.home, '.claude', 'dashboard-refresh'));
      const before = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(before.recent.map(r => r.dirName), [mine.dirName]);

      // Not on any list, so the gate does not know it.
      assert.equal((await post(h, { dirName: own.dirName, pinned: true })).status, 404);
      assert.deepStrictEqual(getPinnedProjects(), []);

      // A pin stored before the filter existed stays in the list so it can be unpinned, but nothing lists it.
      setPinned(own.dirName, true);
      const after = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(after.pinned.map(r => [r.dirName, r.listed]), [[own.dirName, false]]);
      assert.deepStrictEqual(after.recent.map(r => r.dirName), [mine.dirName]);
      assert.equal((await post(h, { dirName: own.dirName, pinned: false })).status, 200);
      assert.deepStrictEqual(getPinnedProjects(), []);
    });
  }));

  check(await testAsync('a project inside a worktrees dir is neither offered nor pinnable, whatever its .git', async () => {
    await withPins(ENV, async h => {
      const mine = plantProject(h, 'mine', 1 / 24);
      // A full clone (its own .git dir) parked under a `worktrees` dir, as an A/B harness lays them out.
      const clone = plantProject(h, 'clone', 1 / 24, path.join(h.home, 'ab', 'worktrees', 'v1', 'repo'));
      fs.mkdirSync(path.join(clone.cwd, '.git'));
      // A leftover dir under `.claude/worktrees` whose `.git` file is already gone.
      const leftover = plantProject(h, 'leftover', 5, path.join(mine.cwd, '.claude', 'worktrees', 'feat'));
      const pins = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(pins.recent.map(r => r.dirName), [mine.dirName]);
      assert.deepStrictEqual(pins.older, []);
      assert.equal((await post(h, { dirName: clone.dirName, pinned: true })).status, 404);
      assert.equal((await post(h, { dirName: leftover.dirName, pinned: true })).status, 404);
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

  /* POST /api/pins/order: the whole order, accepted only as an exact permutation of the stored pins. */
  const pinAll = async (h: Harness, names: string[], headers: Record<string, string> = {}): Promise<string[]> => {
    const dirs = names.map((n, i) => plantProject(h, n, 5 + i).dirName);
    for (const dirName of dirs) assert.equal((await post(h, { dirName, pinned: true }, headers)).status, 200, dirName);
    return dirs;
  };

  check(await testAsync('POST /api/pins/order with ANSWER_TOKEN set and no bearer is 403 and reorders nothing', async () => {
    await withPins(ENV + 'ANSWER_TOKEN=s3cret\n', async h => {
      const dirs = await pinAll(h, ['p', 'q'], { Authorization: 'Bearer s3cret' });
      const reply = await postOrder(h, { order: [...dirs].reverse() }, { 'X-Forwarded-For': '192.168.1.5' });
      assert.equal(reply.status, 403);
      assert.equal(reply.json?.error, 'bad token');
      assert.deepStrictEqual(getPinnedProjects(), dirs);
    });
  }));

  check(await testAsync('POST /api/pins/order with a body that is not {order: string[]} is 400 and reorders nothing', async () => {
    await withPins(ENV, async h => {
      const dirs = await pinAll(h, ['p', 'q']);
      for (const body of [{}, { order: 'x' }, { order: ['a', 3] }, { order: [dirs[1], 3] }, '{not json']) {
        const reply = await postOrder(h, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.equal(reply.json?.error, 'expected {order: string[]}', JSON.stringify(body));
      }
      assert.deepStrictEqual(getPinnedProjects(), dirs);
    });
  }));

  check(await testAsync('POST /api/pins/order missing a stored pin is 409 and reorders nothing', async () => {
    await withPins(ENV, async h => {
      const [p, q] = await pinAll(h, ['p', 'q']);
      const reply = await postOrder(h, { order: [p] });
      assert.equal(reply.status, 409);
      assert.equal(reply.json?.error, 'pins changed — reload');
      assert.deepStrictEqual(getPinnedProjects(), [p, q]);
    });
  }));

  check(await testAsync('POST /api/pins/order with a permutation is 200 with the reordered payload, and GET /api/pins agrees', async () => {
    await withPins(ENV, async h => {
      const [p, q, r] = await pinAll(h, ['p', 'q', 'r']);
      const reply = await postOrder(h, { order: [r, p, q] });
      assert.equal(reply.status, 200);
      assert.deepStrictEqual((reply.json as unknown as PinsResponse).pinned.map(row => row.dirName), [r, p, q]);
      const read = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(read.pinned.map(row => row.dirName), [r, p, q]);
      assert.deepStrictEqual(getPinnedProjects(), [r, p, q]);
    });
  }));

  check(await testAsync('a dead pin must be in the order: leaving it out is 409, putting it first is 200', async () => {
    await withPins(ENV, async h => {
      const [p, q] = await pinAll(h, ['p', 'q']);
      fs.rmSync(path.join(h.home, 'projs', 'p'), { recursive: true, force: true });
      const dead = (await h.req('/api/pins')).json as unknown as PinsResponse;
      assert.deepStrictEqual(dead.pinned.map(row => [row.dirName, row.listed]), [[p, false], [q, true]]);

      assert.equal((await postOrder(h, { order: [q] })).status, 409);
      assert.deepStrictEqual(getPinnedProjects(), [p, q]);
      assert.equal((await postOrder(h, { order: [q, p] })).status, 200);
      const reply = await postOrder(h, { order: [p, q] });
      assert.equal(reply.status, 200);
      assert.deepStrictEqual((reply.json as unknown as PinsResponse).pinned.map(row => row.dirName), [p, q]);
    });
  }));

  check(await testAsync('GET /api/pins/order is 405', async () => {
    await withPins(ENV, async h => {
      assert.equal((await h.req('/api/pins/order')).status, 405);
    });
  }));

  /* A throw while listing. Nothing drives these from disk: `listTranscripts` swallows readdir errors, so the payload's seam stands in for the listing. */
  const payloadThrows = async (fn: () => Promise<void>): Promise<void> => {
    overridePinsPayload(() => { throw new Error('listing blew up'); });
    try { await fn(); } finally { overridePinsPayload(null); }
  };

  check(await testAsync('pinning when the reply cannot be built is 500 saved: true, and the pin stood', async () => {
    await withPins(ENV, async h => {
      const { dirName } = plantProject(h, 'old', 5);
      await payloadThrows(async () => {
        const reply = await answered(post(h, { dirName, pinned: true }));
        assert.equal(reply.status, 500);
        assert.strictEqual(reply.json?.saved, true);
        assert.equal(reply.json?.error, 'Saved, but the pin list could not be re-read — reopen to refresh.');
        assert.deepStrictEqual(getPinnedProjects(), [dirName]);
      });
    });
  }));

  check(await testAsync('unpinning when the reply cannot be built is 500 saved: true, and the pin is gone', async () => {
    await withPins(ENV, async h => {
      const [p, q] = await pinAll(h, ['p', 'q']);
      await payloadThrows(async () => {
        const reply = await answered(post(h, { dirName: p, pinned: false }));
        assert.equal(reply.status, 500);
        assert.strictEqual(reply.json?.saved, true);
        assert.deepStrictEqual(getPinnedProjects(), [q]);
      });
    });
  }));

  check(await testAsync('reordering when the reply cannot be built is 500 saved: true, and the new order stood', async () => {
    await withPins(ENV, async h => {
      const [p, q, r] = await pinAll(h, ['p', 'q', 'r']);
      await payloadThrows(async () => {
        const reply = await answered(postOrder(h, { order: [r, p, q] }));
        assert.equal(reply.status, 500);
        assert.strictEqual(reply.json?.saved, true);
        assert.deepStrictEqual(getPinnedProjects(), [r, p, q]);
      });
    });
  }));

  check(await testAsync('GET /api/pins when the payload throws is 500 pins read failed, with no saved flag', async () => {
    await withPins(ENV, async h => {
      await payloadThrows(async () => {
        const reply = await answered(h.req('/api/pins'));
        assert.equal(reply.status, 500);
        assert.equal(reply.json?.error, 'pins read failed');
        assert.strictEqual(reply.json?.saved, undefined);
      });
    });
  }));

  check(await testAsync('a throw in the membership check is 500 without saved, and stores nothing', async () => {
    await withPins(ENV, async h => {
      const { dirName } = plantProject(h, 'old', 5);
      // A root that is not a string makes `isClaudeOwned` throw inside `listOlderProjects`, which the check calls before anything is saved.
      overrideClaudeRoots([null as unknown as string]);
      const reply = await answered(post(h, { dirName, pinned: true }));
      assert.equal(reply.status, 500);
      assert.equal(reply.json?.error, 'pins write failed');
      assert.strictEqual(reply.json?.saved, undefined);
      assert.deepStrictEqual(getPinnedProjects(), []);
    });
  }));

  check(await testAsync('with the seam back to null a pin answers the 200 payload again', async () => {
    await withPins(ENV, async h => {
      const { dirName } = plantProject(h, 'old', 5);
      await payloadThrows(async () => { await answered(h.req('/api/pins')); });
      const reply = await answered(post(h, { dirName, pinned: true }));
      assert.equal(reply.status, 200);
      assert.deepStrictEqual((reply.json as unknown as PinsResponse).pinned.map(row => row.dirName), [dirName]);
    });
  }));

  console.log(`\npins endpoints: ${ok}/${total} passed`);
  return total - ok;
}
