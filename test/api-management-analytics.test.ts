/**
 * The read-only config/report endpoints, driven through the real route table:
 * `GET /api/management`, `GET /api/management/project`, `GET /api/management/file`,
 * `GET /api/analytics`.
 *
 * These three share one design rule that is invisible from their readers'
 * tests: **a path is never joined, always resolved against an enumerated set**.
 * `?dir=` is looked up in the recent-project list and `?path=` in the servable
 * set, so a traversal attempt is a 400/403/404 rather than a file. Everything
 * else here is fail-open behaviour — an unreadable `~/.claude` must answer an
 * honest empty payload with `error: true`, never a 500 that blanks the section.
 *
 * `serveManagementFile` is not in task-7's list of thirteen; it is covered here
 * anyway because it is the one route in this group that reads arbitrary
 * absolute paths, and its 403 is the guard that stops it.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, withServer } from './api-harness.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/** The directory `harness.plant` writes into — the dirName these routes see. */
const PROJECT_DIR = '-fake-proj';

export async function run(): Promise<number> {
  console.log('\n=== management + analytics endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  /* ------------------------------------------------------- /api/management */

  check(await testAsync('GET /api/management is 200 with a global scope and a project list', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req('/api/management');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.error, undefined, 'a readable home is not an error');
      assert.ok(reply.json?.generatedAt, 'the payload is stamped');
      const global = reply.json?.global as { scope: string };
      assert.equal(global.scope, 'global');
      assert.ok(Array.isArray(reply.json?.projects));
    });
  }));

  check(await testAsync('GET /api/management lists a project with a recent transcript', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req('/api/management');
      const projects = reply.json?.projects as Array<{ dirName: string; path: string }>;
      assert.deepEqual(projects.map(p => p.dirName), [PROJECT_DIR]);
      assert.equal(projects[0].path, h.home, "the ref's path comes from the transcript's cwd");
    });
  }));

  /* ----------------------------------------------- /api/management/project */

  check(await testAsync('GET /api/management/project resolves an enumerated dirName', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req(`/api/management/project?dir=${PROJECT_DIR}`);
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.error, undefined);
      assert.equal(reply.json?.scope, 'project');
      assert.equal(reply.json?.root, h.home);
    });
  }));

  check(await testAsync('GET /api/management/project for an unknown project is 404', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req('/api/management/project?dir=-no-such-project');
      assert.equal(reply.status, 404, 'a dirName nobody has is a miss, not a server fault');
      assert.equal(reply.json?.error, true);
      assert.equal(reply.json?.scope, 'project', 'the empty payload is still well-formed');
    });
  }));

  check(await testAsync('GET /api/management/project with a traversal-shaped dir is 400', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      for (const dir of ['../../etc', '/etc/passwd', 'a/b', '']) {
        const reply = await h.req(`/api/management/project?dir=${encodeURIComponent(dir)}`);
        assert.equal(reply.status, 400, `dir=${JSON.stringify(dir)} must fail ID_RE`);
        assert.equal(reply.json?.error, true);
      }
    });
  }));

  /* -------------------------------------------------- /api/management/file */

  check(await testAsync('GET /api/management/file serves an enumerated file', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const claudeMd = path.join(h.home, '.claude', 'CLAUDE.md');
      fs.writeFileSync(claudeMd, '# fake rules\n');
      const reply = await h.req(`/api/management/file?path=${encodeURIComponent(claudeMd)}`);
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.error, undefined);
      assert.equal(reply.json?.content, '# fake rules\n');
    });
  }));

  check(await testAsync('GET /api/management/file is 403 for a real file outside the servable set', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      // Exists and is readable — the only thing stopping it is the allowlist.
      const secret = path.join(h.home, 'secret.txt');
      fs.writeFileSync(secret, 'do not serve me');
      const reply = await h.req(`/api/management/file?path=${encodeURIComponent(secret)}`);
      assert.equal(reply.status, 403);
      assert.equal(reply.json?.error, true);
      assert.equal(reply.json?.content, '');
    });
  }));

  check(await testAsync('GET /api/management/file is 400 for a relative or dot-dot path', async () => {
    await withServer(ENV, async h => {
      for (const p of ['', 'relative/path', '/etc/../etc/passwd']) {
        const reply = await h.req(`/api/management/file?path=${encodeURIComponent(p)}`);
        assert.equal(reply.status, 400, `path=${JSON.stringify(p)} must be refused`);
        assert.equal(reply.json?.error, true);
      }
    });
  }));

  /* -------------------------------------------------------- /api/analytics */

  check(await testAsync('GET /api/analytics is 200 and well-formed with no log at all', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/analytics');
      assert.equal(reply.status, 200, 'a missing log is an empty list, not a 500');
      assert.ok(reply.json?.generatedAt);
      assert.deepEqual(reply.json?.reports, []);
      assert.equal(reply.json?.error, undefined);
      assert.equal(typeof reply.json?.keep, 'number');
    });
  }));

  check(await testAsync('GET /api/analytics reports the configured ANALYTICS_KEEP', async () => {
    await withServer(`${ENV}ANALYTICS_KEEP=3\n`, async h => {
      const reply = await h.req('/api/analytics');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.keep, 3);
    });
  }));

  check(await testAsync('GET /api/analytics returns the entries /kaizen has logged', async () => {
    await withServer(ENV, async h => {
      // The one producer of this file is the /kaizen skill; the reader is
      // covered in analytics.test.ts. What this asserts is only that the
      // endpoint hands the parsed list through rather than swallowing it.
      const log = path.join(h.home, '.claude', 'session-analytics-log.md');
      fs.writeFileSync(log,
        '- 2026-07-12 [demo] abc12345: 160 billable (1.16k ctx), top cost Read. Lesson: keep it tight.\n');
      const reply = await h.req('/api/analytics');
      assert.equal(reply.status, 200);
      const reports = reply.json?.reports as Array<{ sessionId: string; lesson: string; project: string }>;
      assert.equal(reports.length, 1, 'the logged session is listed');
      assert.equal(reports[0].sessionId, 'abc12345');
      assert.equal(reports[0].project, 'demo');
      assert.equal(reports[0].lesson, 'keep it tight.');
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
