/**
 * `POST /api/open-folder`, driven through the real route table: the method, the token gate, the body shape, the macOS gate, and the membership rule — the
 * path must string-equal a listed pin's path, because this route launches `open` on the host and the dashboard is reachable over LAN and the tailnet.
 *
 * `open` itself never runs here: every case installs a recording runner through `overrideOpenFolder` and restores the default in `finally`.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { encodeProjectDir } from '../server/lib/management.js';
import { overrideClaudeRoots } from '../server/lib/paths.js';
import { overrideOpenFolder } from '../server/lib/open-folder.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const DAY = 24 * 3600_000;

/** A project cwd under `$HOME/projs/<name>`, with one transcript `ageDays` old. */
function plantProject(h: Harness, name: string, ageDays: number): { dirName: string; cwd: string } {
  const cwd = path.join(h.home, 'projs', name);
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
  return h.req('/api/open-folder', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
}

/** Calls the runner received, as `[cmd, args]`. */
type Calls = Array<[string, string[]]>;

/**
 * Each case starts with no pins, the Claude-root filter off, and a recording runner on `platform`; it leaves all three restored. `fail` makes the runner
 * reject, standing in for an `open` that exits non-zero.
 */
async function withOpen(env: string, fn: (h: Harness, calls: Calls) => Promise<void>, platform = 'darwin', fail = false): Promise<void> {
  const calls: Calls = [];
  overrideClaudeRoots([]);
  overrideOpenFolder({
    run: async (cmd, args) => { calls.push([cmd, args]); if (fail) throw new Error('open exited 1'); },
    platform
  });
  try {
    await withServer(env, async h => {
      resetSettings();
      try { await fn(h, calls); } finally { resetSettings(); }
    });
  } finally {
    overrideOpenFolder({ run: null, platform: null });
    overrideClaudeRoots(null);
  }
}

/** Plant and pin one project; returns its cwd. */
function pinOne(h: Harness, name = 'proj'): string {
  const { dirName, cwd } = plantProject(h, name, 5);
  assert.ok(setPinned(dirName, true) !== null, 'pinned');
  return cwd;
}

export async function run(): Promise<number> {
  console.log('\n=== open-folder endpoint (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('GET /api/open-folder is 405', async () => {
    await withOpen(ENV, async (h, calls) => {
      assert.equal((await h.req('/api/open-folder')).status, 405);
      assert.deepStrictEqual(calls, []);
    });
  }));

  check(await testAsync('ANSWER_TOKEN set and no bearer is 403 bad token, and open never runs', async () => {
    await withOpen(ENV + 'ANSWER_TOKEN=s3cret\n', async (h, calls) => {
      const cwd = pinOne(h);
      const reply = await post(h, { path: cwd }, { 'X-Forwarded-For': '192.168.1.5' });
      assert.equal(reply.status, 403);
      assert.equal(reply.json?.error, 'bad token');
      assert.deepStrictEqual(calls, []);
    });
  }));

  check(await testAsync('a body that is not {path: non-empty string} is 400, and open never runs', async () => {
    await withOpen(ENV, async (h, calls) => {
      pinOne(h);
      for (const body of [{}, { path: 3 }, '{not json', { path: '' }]) {
        const reply = await post(h, body);
        assert.equal(reply.status, 400, JSON.stringify(body));
        assert.equal(reply.json?.error, 'expected {path: string}', JSON.stringify(body));
      }
      assert.deepStrictEqual(calls, []);
    });
  }));

  check(await testAsync('on linux a pinned path is 501 open folder needs macOS, and open never runs', async () => {
    await withOpen(ENV, async (h, calls) => {
      const cwd = pinOne(h);
      const reply = await post(h, { path: cwd });
      assert.equal(reply.status, 501);
      assert.equal(reply.json?.error, 'open folder needs macOS');
      assert.deepStrictEqual(calls, []);
    }, 'linux');
  }));

  check(await testAsync('a relative or dash-prefixed path is 403 not a pinned project, and open never runs', async () => {
    await withOpen(ENV, async (h, calls) => {
      pinOne(h);
      for (const p of ['-a', '--help', 'projs/proj', './proj', '.']) {
        const reply = await post(h, { path: p });
        assert.equal(reply.status, 403, p);
        assert.equal(reply.json?.error, 'not a pinned project', p);
      }
      assert.deepStrictEqual(calls, []);
    });
  }));

  check(await testAsync('a planted but unpinned path is 403 not a pinned project', async () => {
    await withOpen(ENV, async (h, calls) => {
      pinOne(h, 'pinned');
      const { cwd } = plantProject(h, 'loose', 5);
      const reply = await post(h, { path: cwd });
      assert.equal(reply.status, 403);
      assert.equal(reply.json?.error, 'not a pinned project');
      assert.deepStrictEqual(calls, []);
    });
  }));

  check(await testAsync('a pinned path with a trailing slash is 403: nothing is normalised', async () => {
    await withOpen(ENV, async (h, calls) => {
      const cwd = pinOne(h);
      const reply = await post(h, { path: cwd + '/' });
      assert.equal(reply.status, 403);
      assert.equal(reply.json?.error, 'not a pinned project');
      assert.deepStrictEqual(calls, []);
    });
  }));

  check(await testAsync('a pinned path is 200 {ok: true} and runs open once with the path as its only argument', async () => {
    await withOpen(ENV, async (h, calls) => {
      const cwd = pinOne(h);
      const reply = await post(h, { path: cwd });
      assert.equal(reply.status, 200);
      assert.deepStrictEqual(reply.json, { ok: true });
      assert.deepStrictEqual(calls, [['open', [cwd]]]);
    });
  }));

  check(await testAsync('a runner that rejects is 500 open failed', async () => {
    await withOpen(ENV, async (h, calls) => {
      const cwd = pinOne(h);
      const reply = await post(h, { path: cwd });
      assert.equal(reply.status, 500);
      assert.equal(reply.json?.error, 'open failed');
      assert.deepStrictEqual(calls, [['open', [cwd]]]);
    }, 'darwin', true);
  }));

  console.log(`\nopen-folder endpoint: ${ok}/${total} passed`);
  return total - ok;
}
